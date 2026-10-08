internal import ExpoModulesCore
import AVFoundation
import Foundation
import Speech
import UIKit
import WatchConnectivity

/// A watch capture held on the iPhone until JavaScript has stored it as a task.
private struct WatchInboxEntry: Codable {
  enum State: String, Codable { case received, transcribed, failed }

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
}

/// Receives Apple Watch captures natively. iOS can wake or launch Verity in the
/// background to deliver a WatchConnectivity file; React Native only starts with
/// a UI scene, so receiving, persisting and transcribing cannot wait for
/// JavaScript. `activate()` therefore runs from the app delegate at launch.
final class VerityWatchInbox: NSObject, WCSessionDelegate {
  static let shared = VerityWatchInbox()
  private static let protocolVersion = 1

  /// Set while JavaScript observes the bridge; called after an entry changes.
  var onChange: (() -> Void)?

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
    queue.async {
      for entry in self.entries() where entry.state == .received { self.transcribe(entry.id) }
    }
  }

  // MARK: JavaScript surface

  func transcribed() -> [[String: Any]] {
    queue.sync {
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
      guard isCaptureId(id) else { return }
      try? FileManager.default.removeItem(at: audioURL(id))
      try? FileManager.default.removeItem(at: entryURL(id))
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
        return
      }
      // A resent capture that already arrived: keep the first copy.
      guard !FileManager.default.fileExists(atPath: entryURL(id).path) else {
        log("\(id.prefix(8)) duplicate ignored")
        return
      }
      do {
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
      }
    }
  }

  // MARK: Transcription

  /// Runs on `queue`. Holds a background task so iOS grants time to finish after
  /// a background wake; the result also goes back to the watch.
  private func transcribe(_ id: String) {
    guard !transcribing.contains(id) else { return }
    transcribing.insert(id)
    var backgroundTask = UIBackgroundTaskIdentifier.invalid
    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "watch-transcribe") {
      self.queue.async { self.log("\(id.prefix(8)) background time expired") }
      UIApplication.shared.endBackgroundTask(backgroundTask)
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
        UIApplication.shared.endBackgroundTask(backgroundTask)
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
    if WCSession.default.activationState == .activated {
      WCSession.default.transferUserInfo(reply)
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

class VerityWatchBridge: Module {
  public func definition() -> ModuleDefinition {
    Name("VerityWatchBridge")
    Events("onWatchInbox")

    OnStartObserving {
      VerityWatchInbox.shared.onChange = { [weak self] in self?.sendEvent("onWatchInbox", [:]) }
    }
    OnStopObserving {
      VerityWatchInbox.shared.onChange = nil
    }

    AsyncFunction("pending") { () -> [[String: Any]] in
      VerityWatchInbox.shared.transcribed()
    }
    AsyncFunction("acknowledge") { (id: String) in
      VerityWatchInbox.shared.acknowledge(id)
    }
    AsyncFunction("log") { () -> [String] in
      VerityWatchInbox.shared.logLines()
    }
    AsyncFunction("status") { () -> [String: Any] in
      VerityWatchInbox.shared.status()
    }
  }
}
