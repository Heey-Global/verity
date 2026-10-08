import AVFoundation
import Foundation
import WatchConnectivity

/// One voice capture on the watch. The audio stays on disk until the iPhone has
/// sent back its transcript, so a capture survives an unreachable phone, a
/// relaunch, a watch restart or an iPhone that could not store the file, and is
/// offered again from `resend()`.
struct Capture: Codable, Identifiable, Equatable {
  enum State: String, Codable {
    /// Recorded; waiting for WatchConnectivity to deliver the file.
    case queued
    /// Transferred; the transcript has not come back yet.
    case delivered
    case transcribed
    case failed
  }

  let id: String
  let createdAt: Date
  let durationMs: Int
  var state: State
  var text: String?
  /// The iPhone refused the file. Kept apart from `state` because the refusal
  /// can arrive before WatchConnectivity reports the transfer as finished.
  var rejected: Bool?
}

/// Wire format shared with `VerityWatchInbox` on the iPhone. Bump `version` on
/// any incompatible change; each side ignores payloads it does not understand.
enum WatchProtocol {
  static let version = 1
}

@MainActor
final class CaptureStore: NSObject, ObservableObject {
  static let shared = CaptureStore()

  @Published private(set) var captures: [Capture] = []
  @Published private(set) var recording = false
  @Published private(set) var level: Float = 0
  @Published private(set) var elapsed: TimeInterval = 0
  @Published private(set) var phoneReachable = false
  @Published var error: String?

  private var recorder: AVAudioRecorder?
  private var meter: Timer?
  private var current: (id: String, start: Date)?
  private var starting = false
  private var heardSpeech = false
  private var quietSince: Date?
  private let directory: URL
  private let indexURL: URL

  private override init() {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    directory = documents.appendingPathComponent("captures", isDirectory: true)
    indexURL = directory.appendingPathComponent("index.json")
    super.init()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let data = try? Data(contentsOf: indexURL),
      let saved = try? JSONDecoder().decode([Capture].self, from: data)
    {
      captures = saved
    }
  }

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  // MARK: Recording

  func toggle() {
    recording ? stop() : start()
  }

  func start() {
    // The permission prompt is async: a second tap meanwhile must not start a second recorder.
    guard !recording, !starting else { return }
    starting = true
    error = nil
    Task {
      defer { starting = false }
      guard await AVAudioApplication.requestRecordPermission() else {
        error = "Allow microphone access for Verity in the Watch settings."
        return
      }
      do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let id = UUID().uuidString.lowercased()
        let recorder = try AVAudioRecorder(
          url: audioURL(id),
          settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
          ])
        recorder.isMeteringEnabled = true
        guard recorder.record() else { throw CaptureError.recorder }
        self.recorder = recorder
        current = (id, Date())
        heardSpeech = false
        quietSince = nil
        elapsed = 0
        recording = true
        meter = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
          Task { @MainActor in CaptureStore.shared.tick() }
        }
      } catch {
        self.error = "Recording could not start."
      }
    }
  }

  func stop() {
    guard recording, let recorder, let current else { return }
    meter?.invalidate()
    meter = nil
    recorder.stop()
    try? AVAudioSession.sharedInstance().setActive(false)
    self.recorder = nil
    self.current = nil
    recording = false
    level = 0
    let capture = Capture(
      id: current.id, createdAt: current.start,
      durationMs: Int(Date().timeIntervalSince(current.start) * 1000), state: .queued)
    captures.insert(capture, at: 0)
    persist()
    send(capture)
  }

  /// Meter tick: drives the level bars and stops after ~1.5 s of silence once
  /// speech was heard, so a short note needs no second tap.
  private func tick() {
    guard let recorder, let current else { return }
    recorder.updateMeters()
    let power = recorder.averagePower(forChannel: 0)  // dBFS, about -160...0
    level = max(0, min(1, (power + 50) / 50))
    elapsed = Date().timeIntervalSince(current.start)
    if power > -30 {
      heardSpeech = true
      quietSince = nil
    } else if heardSpeech {
      let since = quietSince ?? Date()
      quietSince = since
      if Date().timeIntervalSince(since) > 1.5 { stop() }
    }
  }

  // MARK: Delivery

  private func send(_ capture: Capture) {
    let session = WCSession.default
    guard session.activationState == .activated else { return }
    let url = audioURL(capture.id)
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    session.transferFile(
      url,
      metadata: [
        "v": WatchProtocol.version,
        "kind": "capture",
        "id": capture.id,
        "createdAt": ISO8601DateFormatter().string(from: capture.createdAt),
        "durationMs": capture.durationMs,
      ])
  }

  /// Re-offer every queued capture that the system is not already transferring.
  /// WatchConnectivity keeps its own queue across launches, so only files it lost
  /// (for example after the transfer failed) are sent again.
  private func resend() {
    let inFlight = Set(
      WCSession.default.outstandingFileTransfers.compactMap { $0.file.metadata?["id"] as? String })
    // A delivered capture with no reply after a while may have been lost on the
    // iPhone (reinstall, cleared inbox); the iPhone ignores a copy it already has.
    let stale = Date().addingTimeInterval(-10 * 60)
    for capture in captures
    where (capture.state == .queued || (capture.state == .delivered && capture.createdAt < stale))
      && !inFlight.contains(capture.id)
    {
      update(capture.id) { $0.rejected = nil }
      send(capture)
    }
  }

  private func update(_ id: String, _ change: (inout Capture) -> Void) {
    guard let index = captures.firstIndex(where: { $0.id == id }) else { return }
    change(&captures[index])
    persist()
  }

  private func persist() {
    // Keep the history short, but never drop a capture still waiting to reach the
    // iPhone: its entry is the only thing that offers the audio again.
    var settled = 0
    captures = captures.filter { capture in
      // Queued and delivered captures may still need their audio sent (again).
      guard capture.state == .transcribed || capture.state == .failed else { return true }
      settled += 1
      if settled <= 20 { return true }
      try? FileManager.default.removeItem(at: audioURL(capture.id))
      return false
    }
    guard let data = try? JSONEncoder().encode(captures) else { return }
    try? data.write(to: indexURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  private func audioURL(_ id: String) -> URL {
    directory.appendingPathComponent("\(id).m4a")
  }

  private enum CaptureError: Error { case recorder }
}

extension CaptureStore: WCSessionDelegate {
  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    let reachable = session.isReachable
    Task { @MainActor in
      self.phoneReachable = reachable
      if activationState == .activated { self.resend() }
    }
  }

  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    let reachable = session.isReachable
    Task { @MainActor in self.phoneReachable = reachable }
  }

  nonisolated func session(
    _ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?
  ) {
    guard let id = fileTransfer.file.metadata?["id"] as? String else { return }
    let failed = error != nil
    Task { @MainActor in
      if failed {
        // Leave it queued; the next activation or launch offers it again.
        return
      }
      self.update(id) { if $0.state == .queued && $0.rejected != true { $0.state = .delivered } }
    }
  }

  nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    guard userInfo["v"] as? Int == WatchProtocol.version, let id = userInfo["id"] as? String
    else { return }
    let kind = userInfo["kind"] as? String
    let text = userInfo["text"] as? String
    Task { @MainActor in
      self.update(id) { capture in
        switch kind {
        case "transcript":
          capture.state = .transcribed
          capture.text = text
          try? FileManager.default.removeItem(at: self.audioURL(id))
        case "rejected":
          // The iPhone could not store the file: queue it for the next launch.
          // Resending at once would loop while the iPhone's condition lasts.
          capture.state = .queued
          capture.rejected = true
        case "failed":
          capture.state = .failed
          capture.text = text
        default:
          break
        }
      }
    }
  }
}
