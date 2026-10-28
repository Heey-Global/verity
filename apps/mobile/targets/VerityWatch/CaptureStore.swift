import AVFoundation
import Combine
import Foundation
import WatchConnectivity
import WatchKit

/// One voice capture on the watch. The audio stays on disk until the iPhone has
/// sent back its transcript, so a capture survives an unreachable phone, a
/// relaunch, a watch restart or an iPhone that could not store the file, and is
/// offered again from `resend()`. A capture is only sent once it has a
/// project: picked after the recording, or the last project used when the
/// picker is left without a tap. It waits on the watch as "Choose project"
/// when no list is on the watch, when its account is unknown or differs from
/// the list's (`settle`), or when it was recovered from a cut-short recording.
struct Capture: Codable, Identifiable, Equatable {
  enum State: String, Codable {
    /// Recorded; waiting for a project, then for WatchConnectivity to deliver the file.
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
  /// Picked on the watch. `scope` is the account the project list came from,
  /// so the iPhone never files the task under a different account.
  var projectId: String?
  var projectName: String?
  var scope: String?
}

/// A project the picker offers, as the iPhone sent it.
struct WatchProject: Codable, Identifiable, Equatable, Sendable {
  let id: String
  let name: String
}

/// The iPhone's latest project list (`VerityWatchInbox.setProjects`), stored so
/// the picker works while the phone is away.
struct ProjectList: Codable, Equatable, Sendable {
  var scope: String?
  var projects: [WatchProject] = []
  /// Most recently used on the iPhone's quick capture.
  var phoneLastProjectId: String?
  /// Most recently picked on the watch; wins over the iPhone's choice.
  var watchLastProjectId: String?
  /// Picked before that; the second shortcut in the picker.
  var watchPreviousProjectId: String?

  /// Parses an application context; nil for anything that is not a project list.
  init?(context: [String: Any]) {
    guard context["v"] as? Int == WatchProtocol.version, context["kind"] as? String == "projects",
      let projects = context["projects"] as? [[String: String]]
    else { return nil }
    scope = context["scope"] as? String
    self.projects = projects.compactMap { project in
      guard let id = project["id"], let name = project["name"] else { return nil }
      return WatchProject(id: id, name: name)
    }
    phoneLastProjectId = context["lastProjectId"] as? String
  }

  init() {}
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
  @Published private(set) var projectList = ProjectList()
  /// The capture the project picker is open for.
  @Published private(set) var choosing: String?
  /// The picker was opened from a row, not by a recording: it offers "Back".
  @Published private(set) var reopened = false
  /// Brief feedback after a project was picked.
  @Published private(set) var confirmation: Confirmation?

  struct Confirmation: Equatable {
    let title: String
    let detail: String
  }

  private var recorder: AVAudioRecorder?
  private var meter: Timer?
  private var current: (id: String, start: Date, scope: String?)?
  private var starting = false
  private var heardSpeech = false
  private var quietSince: Date?
  private let directory: URL
  private let indexURL: URL
  private let projectsURL: URL
  private var confirmationReset: Task<Void, Never>?

  private override init() {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    directory = documents.appendingPathComponent("captures", isDirectory: true)
    indexURL = directory.appendingPathComponent("index.json")
    projectsURL = documents.appendingPathComponent("projects.json")
    super.init()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let data = try? Data(contentsOf: indexURL),
      let saved = try? JSONDecoder().decode([Capture].self, from: data)
    {
      captures = saved
    }
    if let data = try? Data(contentsOf: projectsURL),
      let saved = try? JSONDecoder().decode(ProjectList.self, from: data)
    {
      projectList = saved
    }
    recoverInterruptedRecordings()
    settleProjectless()
  }

  /// A recording only enters the index when it stops. If watchOS ended the app
  /// mid-recording, its audio is still on disk: queue it rather than lose it.
  private func recoverInterruptedRecordings() {
    let known = Set(captures.map(\.id))
    let files =
      (try? FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.creationDateKey])) ?? []
    var recovered = false
    for file in files where file.pathExtension == "m4a" {
      let id = file.deletingPathExtension().lastPathComponent
      guard UUID(uuidString: id) != nil, !known.contains(id) else { continue }
      let created =
        (try? file.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
      // No scope: the file may be cut short, so it waits for a tap rather than
      // being filed by the fallback.
      captures.insert(Capture(id: id, createdAt: created, durationMs: 0, state: .queued), at: 0)
      recovered = true
    }
    if recovered { persist() }
  }

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  // MARK: Projects

  /// The picker's order: the projects picked here last and before that, then
  /// the iPhone's last, then the iPhone's order (most recently captured into first).
  var orderedProjects: [WatchProject] {
    let projects = projectList.projects
    var ordered: [WatchProject] = []
    for id in [
      projectList.watchLastProjectId, projectList.watchPreviousProjectId,
      projectList.phoneLastProjectId,
    ].compactMap({ $0 }) {
      if let project = projects.first(where: { $0.id == id }), !ordered.contains(project) {
        ordered.append(project)
      }
    }
    return ordered + projects.filter { !ordered.contains($0) }
  }

  /// The two shortcuts on top of the picker.
  var shortcutProjects: [WatchProject] { Array(orderedProjects.prefix(2)) }
  var otherProjects: [WatchProject] { Array(orderedProjects.dropFirst(2)) }
  /// Where a capture goes when the picker is left without a tap.
  var fallbackProject: WatchProject? { orderedProjects.first }

  /// Opens the picker for a capture still waiting as "Choose project".
  func reopen(_ id: String) {
    guard captures.contains(where: { $0.id == id && $0.projectId == nil }) else { return }
    reopened = true
    choosing = id
  }

  /// Closes a reopened picker without a pick; the capture keeps waiting.
  func closePicker() {
    choosing = nil
    reopened = false
  }

  /// Files the capture under `project` and hands it to the iPhone.
  func assign(_ id: String, to project: WatchProject) {
    guard fileCapture(id, under: project) else {
      choosing = nil
      return
    }
    if project.id != projectList.watchLastProjectId {
      projectList.watchPreviousProjectId = projectList.watchLastProjectId
      projectList.watchLastProjectId = project.id
      saveProjects()
    }
    choosing = nil
    reopened = false
    WKInterfaceDevice.current().play(.success)
    confirm(
      Confirmation(
        title: "Saved to \(project.name)",
        detail: phoneReachable ? "Transcribing on iPhone…" : "Sends when iPhone is nearby"))
  }

  /// Closes the picker without a pick: the capture goes to the last project
  /// used. Without any project list it stays as "Choose project".
  func settleChoice() {
    guard let id = choosing else { return }
    choosing = nil
    // A picker reopened from a row closes like "Back": the capture keeps waiting.
    if reopened {
      reopened = false
      return
    }
    settle(id)
  }

  /// Files every capture of the current account that still has no project
  /// (one left in the picker while the list changed) under the last project
  /// used. A capture spoken before any list was on the watch has no account
  /// and keeps waiting for a tap, like one from another account.
  private func settleProjectless() {
    for capture in captures where capture.projectId == nil && capture.id != choosing {
      settle(capture.id)
    }
  }

  /// Files the capture under the fallback project, but only when it was spoken
  /// under the account whose list is on the watch now. A capture from another
  /// account, or one whose account is unknown (recorded before any list came,
  /// or filed by an older version), keeps waiting as "Choose project": only a
  /// tap may cross accounts.
  private func settle(_ id: String) {
    guard let project = fallbackProject,
      let capture = captures.first(where: { $0.id == id }),
      capture.scope != nil && capture.scope == projectList.scope
    else { return }
    _ = fileCapture(id, under: project)
  }

  /// Records the project on the capture and sends it. False if the capture is
  /// unknown or already filed.
  private func fileCapture(_ id: String, under project: WatchProject) -> Bool {
    guard captures.contains(where: { $0.id == id && $0.projectId == nil }) else { return false }
    update(id) {
      $0.projectId = project.id
      $0.projectName = project.name
      $0.scope = projectList.scope
    }
    if let filed = captures.first(where: { $0.id == id }) { send(filed) }
    return true
  }

  private func confirm(_ message: Confirmation) {
    confirmation = message
    confirmationReset?.cancel()
    confirmationReset = Task {
      try? await Task.sleep(for: .seconds(1.5))
      guard !Task.isCancelled else { return }
      confirmation = nil
    }
  }

  private func receive(_ list: ProjectList) {
    var next = list
    // A pick on the watch only means something within the same account.
    if list.scope == projectList.scope {
      next.watchLastProjectId = projectList.watchLastProjectId
      next.watchPreviousProjectId = projectList.watchPreviousProjectId
    }
    guard next != projectList else { return }
    projectList = next
    saveProjects()
    settleProjectless()
  }

  private func saveProjects() {
    guard let data = try? JSONEncoder().encode(projectList) else { return }
    try? data.write(to: projectsURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
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
        // The account whose list is on the watch as the recording starts: a
        // fallback never files the capture under a list that arrives later.
        current = (id, Date(), projectList.scope)
        heardSpeech = false
        quietSince = nil
        elapsed = 0
        // A picker still open for the previous capture: file it under the last project.
        settleChoice()
        choosing = nil
        confirmation = nil
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
      durationMs: Int(Date().timeIntervalSince(current.start) * 1000), state: .queued,
      scope: current.scope)
    captures.insert(capture, at: 0)
    persist()
    // Sent once a project is picked, or filed under the last one on leaving the picker.
    reopened = false
    choosing = capture.id
  }

  /// Meter tick: drives the level bars and stops after ~1.5 s of silence once
  /// speech was heard, so a short note needs no second tap. A forgotten
  /// recording stops after five minutes.
  private func tick() {
    guard let recorder, let current else { return }
    recorder.updateMeters()
    let power = recorder.averagePower(forChannel: 0)  // dBFS, about -160...0
    level = max(0, min(1, (power + 50) / 50))
    elapsed = Date().timeIntervalSince(current.start)
    if elapsed > 5 * 60 {
      stop()
      return
    }
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
    guard let projectId = capture.projectId else { return }
    let url = audioURL(capture.id)
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    var metadata: [String: Any] = [
      "v": WatchProtocol.version,
      "kind": "capture",
      "id": capture.id,
      "createdAt": ISO8601DateFormatter().string(from: capture.createdAt),
      "durationMs": capture.durationMs,
      "projectId": projectId,
    ]
    if let scope = capture.scope { metadata["scope"] = scope }
    session.transferFile(url, metadata: metadata)
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
    where capture.projectId != nil
      && (capture.state == .queued || (capture.state == .delivered && capture.createdAt < stale))
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
    let list = ProjectList(context: session.receivedApplicationContext)
    Task { @MainActor in
      self.phoneReachable = reachable
      if let list { self.receive(list) }
      if activationState == .activated { self.resend() }
    }
  }

  nonisolated func session(
    _ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]
  ) {
    guard let list = ProjectList(context: applicationContext) else { return }
    Task { @MainActor in self.receive(list) }
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
