import AVFoundation
import Combine
import Foundation
import WatchConnectivity
import WatchKit

/// One thing said to Verity on the watch. The audio stays on disk until the
/// iPhone has sent back its transcript, so a capture survives an unreachable
/// phone, a relaunch, a watch restart or an iPhone that could not store the
/// file, and is offered again from `resend()`. The iPhone passes the transcript
/// to Verity under the capture's id, so a capture sent twice reaches her once.
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
  /// Picked on watch builds that still had a project picker; new captures leave
  /// it empty. `scope` is the account the watch knew while recording, so the
  /// iPhone never hands the words to a different account's Verity.
  var projectId: String?
  var projectName: String?
  var scope: String?
}

/// A project the picker offers, as the iPhone sent it.
struct WatchProject: Codable, Identifiable, Equatable, Sendable {
  let id: String
  let name: String
}

/// The iPhone's latest project list (`VerityWatchInbox.setProjects`). The watch
/// only needs its account (`scope`) now; the list itself is kept for older payloads.
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
/// Additions that an older side can ignore (`target`, `verity`, `answer`) keep it.
enum WatchProtocol {
  static let version = 1
}

/// Verity's conversation as the iPhone last saw it (`lib/watchCapture.ts`):
/// small enough for the wrist, the full conversation stays on the iPhone.
struct VeritySnapshot: Equatable, Sendable {
  struct Question: Equatable, Sendable {
    let id: String
    let text: String?
    let options: [String]
    let multiSelect: Bool
  }

  /// `ready`, `disabled`, `unavailable` or `denied`.
  let availability: String
  /// `idle`, `working`, `needs_you` or `failed`.
  let state: String
  let reply: String?
  let question: Question?
  let approvals: Int
  let scope: String?

  init?(context: [String: Any]) {
    guard context["v"] as? Int == WatchProtocol.version,
      let verity = context["verity"] as? [String: Any],
      let availability = verity["availability"] as? String,
      let state = verity["state"] as? String
    else { return nil }
    self.availability = availability
    self.state = state
    reply = verity["reply"] as? String
    approvals = verity["approvals"] as? Int ?? 0
    scope = verity["scope"] as? String
    if let question = verity["question"] as? [String: Any], let id = question["id"] as? String,
      let options = question["options"] as? [String], !options.isEmpty
    {
      self.question = Question(
        id: id, text: question["text"] as? String, options: options,
        multiSelect: question["multiSelect"] as? Bool ?? false)
    } else {
      question = nil
    }
  }
}

/// Home's open items as the iPhone last listed them (`syncWatchInbox` in
/// `lib/watchCapture.ts`): the same "Needs you" list, decided on the iPhone.
struct WatchInbox: Equatable, Sendable {
  struct Item: Equatable, Sendable, Identifiable {
    let id: String
    let title: String
    let context: String
    let tag: String
    /// `action`, `attention`, `success` or `neutral`, as on Home.
    let tone: String
    let message: String?
  }

  let scope: String?
  /// When the iPhone read the list.
  let at: Date
  let items: [Item]

  /// Reads the `inbox` part of an application context or message; nil without one.
  init?(context: [String: Any]) {
    guard context["v"] as? Int == WatchProtocol.version,
      let inbox = context["inbox"] as? [String: Any],
      let items = inbox["items"] as? [[String: Any]]
    else { return nil }
    scope = inbox["scope"] as? String
    at = Date(timeIntervalSince1970: (inbox["at"] as? Double ?? 0) / 1000)
    self.items = items.compactMap { item in
      guard let id = item["key"] as? String, let title = item["title"] as? String else {
        return nil
      }
      return Item(
        id: id, title: title, context: item["context"] as? String ?? "",
        tag: item["tag"] as? String ?? "", tone: item["tone"] as? String ?? "neutral",
        message: item["message"] as? String)
    }
  }
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
  /// Verity's conversation as the iPhone last reported it.
  @Published private(set) var verity: VeritySnapshot?
  /// Home's open items as the iPhone last listed them.
  @Published private(set) var inbox: WatchInbox?
  /// Questions answered here whose answer may still be on its way.
  @Published private(set) var answered: Set<String> = []
  /// Brief feedback after a recording was handed over.
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
  private let answeredKey = "verity.answeredQuestions"
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
    answered = Set(UserDefaults.standard.stringArray(forKey: answeredKey) ?? [])
    recoverInterruptedRecordings()
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
      // No scope: the iPhone hands it to the account signed in there.
      captures.insert(Capture(id: id, createdAt: created, durationMs: 0, state: .queued), at: 0)
      recovered = true
    }
    if recovered {
      persist()
      resendWhenActive()
    }
  }

  /// Sends what recovery queued once WatchConnectivity is up; activation also resends.
  private func resendWhenActive() {
    if WCSession.default.activationState == .activated { resend() }
  }

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  // MARK: Verity

  /// Nothing sent yet reached the iPhone, and the iPhone is away: words wait on
  /// the watch. Distinct from Verity working on something she already has.
  var waitingForPhone: Bool {
    !phoneReachable
      && (captures.contains { $0.state == .queued }
        || !WCSession.default.outstandingUserInfoTransfers.isEmpty)
  }

  /// The open question, unless it was answered here and the answer is on its way.
  var openQuestion: VeritySnapshot.Question? {
    guard let question = verity?.question, !answered.contains(question.id) else { return nil }
    return question
  }

  /// Answers Verity's open question. WatchConnectivity queues the answer across
  /// launches until the iPhone takes it; the iPhone sends it under this id, so
  /// a repeated delivery is one answer, and one given on the iPhone first wins.
  func answer(_ question: VeritySnapshot.Question, with labels: [String]) {
    guard !labels.isEmpty, WCSession.default.activationState == .activated else {
      error = "Not connected to iPhone yet. Try again in a moment."
      return
    }
    var payload: [String: Any] = [
      "v": WatchProtocol.version, "kind": "answer", "id": UUID().uuidString.lowercased(),
      "questionId": question.id, "labels": labels,
    ]
    if let scope = projectList.scope { payload["scope"] = scope }
    // The queued transfer survives an absent iPhone; the message arrives at once
    // while it is near. The iPhone takes the second copy of the same id as one.
    WCSession.default.transferUserInfo(payload)
    if WCSession.default.isReachable {
      WCSession.default.sendMessage(payload, replyHandler: nil, errorHandler: nil)
    }
    answered.insert(question.id)
    UserDefaults.standard.set(Array(answered), forKey: answeredKey)
    WKInterfaceDevice.current().play(.success)
    confirm(
      Confirmation(
        title: "Answered",
        detail: phoneReachable ? "Verity continues." : "Sends when iPhone is nearby"))
  }

  /// Asks the iPhone for Verity's state while it is near. Its reply carries what
  /// it knows at once; it then reads the server and sends every change.
  func refreshVerity() {
    let session = WCSession.default
    guard session.activationState == .activated, session.isReachable else { return }
    session.sendMessage(
      ["v": WatchProtocol.version, "kind": "refresh"],
      // Runs on a WatchConnectivity queue, not the main actor.
      replyHandler: { @Sendable reply in
        let snapshot = VeritySnapshot(context: reply)
        let inbox = WatchInbox(context: reply)
        Task { @MainActor in
          if let snapshot { self.receive(snapshot) }
          // The iPhone leaves `inbox` out when it has none (signed out).
          self.inbox = inbox
        }
      }, errorHandler: nil)
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

  private func receive(_ snapshot: VeritySnapshot?) {
    // Another account's conversation never shows here, nor do its questions.
    if let scope = snapshot?.scope, let current = projectList.scope, scope != current { return }
    guard snapshot != verity else { return }
    verity = snapshot
    // Forget answers to questions that are gone, so the set stays small.
    guard let snapshot else { return }
    let current = snapshot.question?.id
    let keep = answered.filter { $0 == current }
    if keep != answered {
      answered = keep
      UserDefaults.standard.set(Array(answered), forKey: answeredKey)
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
        // The account the watch knows as the recording starts.
        current = (id, Date(), projectList.scope)
        heardSpeech = false
        quietSince = nil
        elapsed = 0
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
    send(capture)
    WKInterfaceDevice.current().play(.success)
    confirm(
      Confirmation(
        title: "Sent to Verity",
        detail: phoneReachable ? "Transcribing on iPhone…" : "Sends when iPhone is nearby"))
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
    let url = audioURL(capture.id)
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    var metadata: [String: Any] = [
      "v": WatchProtocol.version,
      "kind": "capture",
      "id": capture.id,
      "createdAt": ISO8601DateFormatter().string(from: capture.createdAt),
      "durationMs": capture.durationMs,
      "target": "verity",
    ]
    if let projectId = capture.projectId { metadata["projectId"] = projectId }
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
    let list = ProjectList(context: session.receivedApplicationContext)
    let snapshot = VeritySnapshot(context: session.receivedApplicationContext)
    let inbox = WatchInbox(context: session.receivedApplicationContext)
    Task { @MainActor in
      self.phoneReachable = reachable
      if let list { self.receive(list) }
      self.receive(snapshot)
      self.inbox = inbox
      if activationState == .activated {
        self.resend()
        self.refreshVerity()
      }
    }
  }

  nonisolated func session(
    _ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]
  ) {
    let list = ProjectList(context: applicationContext)
    let snapshot = VeritySnapshot(context: applicationContext)
    // Without an `inbox` part the iPhone signed out or has none to send.
    let inbox = WatchInbox(context: applicationContext)
    Task { @MainActor in
      if let list { self.receive(list) }
      self.receive(snapshot)
      self.inbox = inbox
    }
  }

  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    let reachable = session.isReachable
    Task { @MainActor in
      self.phoneReachable = reachable
      if reachable { self.refreshVerity() }
    }
  }

  /// Verity's state sent the fast way while this app is open.
  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    if message["kind"] as? String == "inbox" {
      let inbox = WatchInbox(context: message)
      Task { @MainActor in self.inbox = inbox }
      return
    }
    guard message["kind"] as? String == "verity", let snapshot = VeritySnapshot(context: message)
    else { return }
    Task { @MainActor in self.receive(snapshot) }
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
