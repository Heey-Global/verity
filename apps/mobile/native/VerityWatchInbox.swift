import AVFoundation
import Foundation
import Speech
import UIKit
import WatchConnectivity

/// A watch capture held on the iPhone until JavaScript has stored it as a task.
private struct WatchInboxEntry: Codable {
  /// `stored`: JavaScript saved the task. The entry stays without audio for a
  /// while so a late redelivery of the same recording is recognised, not saved again.
  enum State: String, Codable { case received, transcribed, failed, stored }

  let id: String
  let createdAt: String
  let durationMs: Int
  let receivedAt: Date
  /// Whether iOS delivered the file while no UI scene was active, i.e. the
  /// launch or wake the background prototype is meant to measure.
  let receivedInBackground: Bool
  var state: State
  var text: String?
  var error: String?
  var transcribeMs: Int?
  /// Transcription attempts so far; optional so entries from older builds decode.
  var attempts: Int?
  var lastAttemptAt: Date?
}

/// Receives Apple Watch captures natively. iOS can wake or launch Verity in the
/// background to deliver a WatchConnectivity file; React Native only starts with
/// a UI scene, so receiving, persisting and transcribing cannot wait for
/// JavaScript. `activate()` therefore runs from the app delegate at launch.
final class VerityWatchInbox: NSObject, WCSessionDelegate {
  static let shared = VerityWatchInbox()
  private static let protocolVersion = 1
  /// A failure on a background wake is often transient (speech assets still
  /// downloading, background time expired), so an unfinished entry is retried
  /// at a later launch or activation: at most this many attempts, spaced so a
  /// burst of activations cannot use them up within seconds.
  private static let maxAttempts = 3
  private static let retrySpacing: TimeInterval = 5 * 60
  /// Entries that used up their attempts keep their audio this long, and stored
  /// entries are remembered this long, then both go.
  private static let retention: TimeInterval = 7 * 24 * 60 * 60

  /// Set while JavaScript observes the bridge; called after an entry changes.
  /// Only touched on `queue`.
  private var onChange: (() -> Void)?

  private let queue = DispatchQueue(label: "build.verity.watch-inbox")
  private let directory: URL
  private var transcribing = Set<String>()

  private override init() {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    directory = support.appendingPathComponent("watch-inbox", isDirectory: true)
    super.init()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
    // A previous run may have been suspended mid-transcription.
    queue.async { self.retry() }
  }

  func observe(_ handler: (() -> Void)?) {
    queue.async { self.onChange = handler }
  }

  /// On `queue`: transcribe what a previous run left unfinished. Entries that
  /// used up their attempts, and stored ones, stay until `retention`.
  private func retry() {
    let now = Date()
    for entry in entries() where entry.state != .transcribed && !transcribing.contains(entry.id) {
      let expired = now.timeIntervalSince(entry.receivedAt) > Self.retention
      if entry.state == .stored {
        if expired { remove(entry.id) }
      } else if (entry.attempts ?? 0) >= Self.maxAttempts {
        if expired {
          remove(entry.id)
          log("\(entry.id.prefix(8)) removed after \(Self.maxAttempts) failed attempts")
        }
      } else if entry.lastAttemptAt.map({ now.timeIntervalSince($0) > Self.retrySpacing }) ?? true {
        transcribe(entry.id)
      }
    }
  }

  // MARK: JavaScript surface

  func transcribed() -> [[String: Any]] {
    // JavaScript drains on every activation: a good moment to retry failures.
    queue.async { self.retry() }
    return queue.sync {
      entries().filter { $0.state == .transcribed }.map { entry in
        [
          "id": entry.id, "text": entry.text ?? "", "createdAt": entry.createdAt,
          "durationMs": entry.durationMs,
        ]
      }
    }
  }

  func acknowledge(_ id: String) {
    queue.sync {
      guard isCaptureId(id), var entry = load(id) else { return }
      try? FileManager.default.removeItem(at: audioURL(id))
      entry.state = .stored
      try? save(entry)
      log("\(id.prefix(8)) stored as task")
    }
  }

  func logLines() -> [String] {
    queue.sync { readLog() }
  }

  func status() -> [String: Any] {
    let session = WCSession.default
    guard WCSession.isSupported() else { return ["supported": false] }
    return [
      "supported": true,
      "activated": session.activationState == .activated,
      "paired": session.isPaired,
      "watchAppInstalled": session.isWatchAppInstalled,
      "reachable": session.isReachable,
    ]
  }

  // MARK: WCSessionDelegate

  func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    queue.async {
      self.log("session \(activationState == .activated ? "activated" : "inactive")\(error.map { ": \($0.localizedDescription)" } ?? "")")
    }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    // Switching to another paired watch: reactivate for the new one.
    WCSession.default.activate()
  }

  func session(_ session: WCSession, didReceive file: WCSessionFile) {
    let background = applicationIsBackground()
    // The system deletes the file when this method returns: move it now.
    queue.sync {
      guard let metadata = file.metadata,
        metadata["v"] as? Int == Self.protocolVersion,
        metadata["kind"] as? String == "capture",
        let id = metadata["id"] as? String, isCaptureId(id)
      else {
        log("ignored a file with unknown metadata")
        // Let the watch keep its copy and offer it again after an update.
        if let id = file.metadata?["id"] as? String { reply(["kind": "rejected", "id": id]) }
        return
      }
      // A resent capture that already arrived: keep the first copy, and repeat
      // the transcript in case the watch never received it.
      if let existing = load(id) {
        log("\(id.prefix(8)) duplicate ignored")
        if existing.state == .transcribed || existing.state == .stored, let text = existing.text {
          reply(["kind": "transcript", "id": id, "text": text])
        }
        return
      }
      do {
        // Audio without an entry is a leftover from a failed earlier save.
        try? FileManager.default.removeItem(at: audioURL(id))
        try FileManager.default.moveItem(at: file.fileURL, to: audioURL(id))
        let entry = WatchInboxEntry(
          id: id, createdAt: metadata["createdAt"] as? String ?? "",
          durationMs: metadata["durationMs"] as? Int ?? 0, receivedAt: Date(),
          receivedInBackground: background, state: .received)
        try save(entry)
        log("\(id.prefix(8)) received \(entry.durationMs) ms audio, app \(background ? "background" : "foreground")")
        transcribe(id)
      } catch {
        log("\(id.prefix(8)) could not be stored: \(error.localizedDescription)")
        remove(id)
        // The watch still holds the audio; this sends it back into its queue.
        reply(["kind": "rejected", "id": id])
      }
    }
  }

  // MARK: Transcription

  /// Runs on `queue`. Holds a background task so iOS grants time to finish after
  /// a background wake; the result also goes back to the watch.
  private func transcribe(_ id: String) {
    guard !transcribing.contains(id), var entry = load(id) else { return }
    transcribing.insert(id)
    entry.attempts = (entry.attempts ?? 0) + 1
    entry.lastAttemptAt = Date()
    entry.state = .received
    try? save(entry)
    let backgroundTime = BackgroundTime("watch-transcribe") {
      self.queue.async { self.log("\(id.prefix(8)) background time expired") }
    }
    let audio = audioURL(id)
    Task {
      let started = Date()
      let result: Result<String, Error>
      do {
        result = .success(try await Self.transcribeFile(audio, log: { message in
          self.queue.async { self.log("\(id.prefix(8)) \(message)") }
        }))
      } catch {
        result = .failure(error)
      }
      let elapsed = Int(Date().timeIntervalSince(started) * 1000)
      self.queue.async {
        self.transcribing.remove(id)
        self.finish(id, result, elapsed: elapsed)
        backgroundTime.end()
      }
    }
  }

  private func finish(_ id: String, _ result: Result<String, Error>, elapsed: Int) {
    guard var entry = load(id) else { return }
    entry.transcribeMs = elapsed
    var reply: [String: Any] = ["v": Self.protocolVersion, "id": id]
    switch result {
    case .success(let text) where !text.isEmpty:
      entry.state = .transcribed
      entry.text = text
      reply["kind"] = "transcript"
      reply["text"] = text
      log("\(id.prefix(8)) transcribed in \(elapsed) ms")
    case .success:
      entry.state = .failed
      entry.error = "No speech recognised"
      reply["kind"] = "failed"
      reply["text"] = entry.error
      log("\(id.prefix(8)) no speech recognised")
    case .failure(let error):
      entry.state = .failed
      entry.error = error.localizedDescription
      reply["kind"] = "failed"
      reply["text"] = "Transcription failed"
      log("\(id.prefix(8)) transcription failed after \(elapsed) ms: \(error.localizedDescription)")
    }
    try? save(entry)
    // The watch only hears about a failure once no retry is left.
    if entry.state == .transcribed || (entry.attempts ?? 0) >= Self.maxAttempts {
      self.reply(reply)
    }
    let notify = onChange
    DispatchQueue.main.async { notify?() }
  }

  private static func transcribeFile(_ url: URL, log: @escaping (String) -> Void) async throws -> String {
    let preferred = Locale(identifier: Locale.preferredLanguages.first ?? "en-US")
    guard SpeechTranscriber.isAvailable,
      let locale = await SpeechTranscriber.supportedLocale(equivalentTo: preferred)
    else { throw InboxError.unavailable("Speech transcription is not available for \(preferred.identifier).") }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    switch await AssetInventory.status(forModules: [transcriber]) {
    case .installed:
      break
    case .supported, .downloading:
      log("downloading \(locale.identifier) speech assets")
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
      }
    case .unsupported:
      throw InboxError.unavailable("Speech assets for \(locale.identifier) are unsupported.")
    @unknown default:
      throw InboxError.unavailable("Unknown speech asset state.")
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collect = Task {
      var parts: [String] = []
      for try await result in transcriber.results {
        parts.append(String(result.text.characters).trimmingCharacters(in: .whitespaces))
      }
      return parts.filter { !$0.isEmpty }.joined(separator: " ")
    }
    let file = try AVAudioFile(forReading: url)
    if let end = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: end)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    return try await collect.value
  }

  // MARK: Storage (on `queue`)

  private func entries() -> [WatchInboxEntry] {
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.pathExtension == "json" }
      .compactMap { try? JSONDecoder().decode(WatchInboxEntry.self, from: Data(contentsOf: $0)) }
      .sorted { $0.receivedAt < $1.receivedAt }
  }

  private func load(_ id: String) -> WatchInboxEntry? {
    (try? Data(contentsOf: entryURL(id))).flatMap { try? JSONDecoder().decode(WatchInboxEntry.self, from: $0) }
  }

  private func reply(_ payload: [String: Any]) {
    guard WCSession.default.activationState == .activated else { return }
    WCSession.default.transferUserInfo(payload.merging(["v": Self.protocolVersion]) { new, _ in new })
  }

  private func remove(_ id: String) {
    try? FileManager.default.removeItem(at: audioURL(id))
    try? FileManager.default.removeItem(at: entryURL(id))
  }

  private func save(_ entry: WatchInboxEntry) throws {
    // Readable after first unlock, so a wake while the phone is locked can still write.
    try JSONEncoder().encode(entry).write(
      to: entryURL(entry.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  /// Timestamped diagnostics for the background prototype, capped in size.
  private func log(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)"
    let lines = readLog().suffix(199) + [line]
    try? lines.joined(separator: "\n").write(to: logURL, atomically: true, encoding: .utf8)
  }

  private func readLog() -> [String] {
    ((try? String(contentsOf: logURL, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
  }

  private var logURL: URL { directory.appendingPathComponent("log.txt") }
  private func audioURL(_ id: String) -> URL { directory.appendingPathComponent("\(id).m4a") }
  private func entryURL(_ id: String) -> URL { directory.appendingPathComponent("\(id).json") }

  /// Ids become file names: accept only the UUIDs the watch generates.
  private func isCaptureId(_ id: String) -> Bool {
    UUID(uuidString: id) != nil && id == id.lowercased()
  }

  /// Called only from WatchConnectivity's delegate queue, never from `queue`:
  /// JavaScript calls block on `queue`, so waiting for main from it could deadlock.
  private func applicationIsBackground() -> Bool {
    let read = { UIApplication.shared.applicationState == .background }
    return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
  }

  private enum InboxError: LocalizedError {
    case unavailable(String)
    var errorDescription: String? {
      switch self { case .unavailable(let reason): return reason }
    }
  }
}

/// A background task that ends exactly once, whether the work finishes or iOS
/// reclaims the time first.
private final class BackgroundTime {
  private let lock = NSLock()
  private var id = UIBackgroundTaskIdentifier.invalid

  init(_ name: String, expired: @escaping () -> Void) {
    let begun = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
      expired()
      self?.end()
    }
    lock.lock()
    id = begun
    lock.unlock()
  }

  func end() {
    lock.lock()
    let current = id
    id = .invalid
    lock.unlock()
    if current != .invalid { UIApplication.shared.endBackgroundTask(current) }
  }
}
