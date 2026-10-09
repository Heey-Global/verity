import Foundation

// Intent belongs to one selected test, not its first socket. A replacement
// must inherit the deadline rather than consume or renew the selection.
final class RemoteDataCaptureWindow {
  private let clock: () -> TimeInterval
  private let lock = NSLock()
  private var deadline: TimeInterval?
  init(clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.clock = clock
  }
  func begin() {
    lock.lock(); defer { lock.unlock() }
    deadline = clock() + RemoteDataDiagnostics.duration
  }
  func begin(existingIsActive: Bool, captureExisting: () -> Bool) -> Bool {
    begin()
    guard existingIsActive else { return true }
    let captured = captureExisting()
    if !captured { clear() }
    return captured
  }
  var remaining: TimeInterval {
    lock.lock(); defer { lock.unlock() }
    return max(0, min(RemoteDataDiagnostics.duration, (deadline ?? clock()) - clock()))
  }
  func clear() { lock.lock(); deadline = nil; lock.unlock() }
}

// A single socket generation, retained after teardown. No peer-controlled text
// is accepted by the event schema, including NSError descriptions and userInfo.
final class RemoteDataDiagnostics: @unchecked Sendable {
  enum Event: String, Codable {
    case captureStarted = "capture_started", socketResume = "socket_resume"
    case socketOpen = "socket_open", attached, failure
    case probeStarted = "probe_started", probeSucceeded = "probe_succeeded", probeFailed = "probe_failed"
    case cancelRequested = "cancel_requested", socketCancel = "socket_cancel"
    case socketClose = "socket_close", taskCompleted = "task_completed"
    case appActive = "app_active", appBackground = "app_background", appInactive = "app_inactive"
    case networkPath = "network_path", counters
    case streamOpenRequested = "stream_open_requested", streamOpened = "stream_opened"
    case streamSendRequested = "stream_send_requested", streamSendCompleted = "stream_send_completed"
    case streamStalled = "stream_stalled"
  }
  enum Cause: String, Codable {
    case appStop = "app_stop", replacement, attachmentDeadline = "attachment_deadline"
    case attachmentFailure = "attachment_failure", readFailure = "read_failure"
    case heartbeatDeadline = "heartbeat_deadline", heartbeatFailure = "heartbeat_failure"
    case streamExhausted = "stream_exhausted", streamStall = "stream_stall"
    case probeFailure = "probe_failure", profileChanged = "profile_changed"
  }
  enum Path: String, Codable { case satisfied, unsatisfied, requiresConnection, unknown }
  enum Proxy: String, Codable { case socks, connect }
  enum End: String, Codable { case open, local, remote, reset, stopped }
  struct StreamSnapshot: Codable {
    let streamId: String
    let proxy: Proxy
    let endedBy: End
    let sentBytes: Int
    let receivedBytes: Int
    let deliveredBytes: Int
    let outgoingFrames: Int
    let incomingFrames: Int
    let outgoingTLSRecords: [UInt8]
    let incomingTLSRecords: [UInt8]
    let firstHandshake: String
  }
  struct Entry: Codable {
    let sequence: Int
    let utc: String
    let elapsedMs: Int
    let event: Event
    let streamId: String?
    let cause: Cause?
    let errorDomain: String?
    let errorCode: Int?
    let closeCode: Int?
    let path: Path?
    let sentBytes: Int?
    let receivedBytes: Int?
    let deliveredBytes: Int?
  }
  struct Snapshot: Encodable {
    let version = 1
    let channel = "DATA"
    let generation: String
    let sessionHash: String?
    let clockOffsetKnown = false
    let startedLate: Bool
    let delegateAvailable: Bool
    let captureLimitMs: Int
    let expired: Bool
    let dropped: Int
    let events: [Entry]
    let streams: [StreamSnapshot]
    let streamUpdatesDropped: Int
  }
  let generation = UUID().uuidString.lowercased()
  private let lock = NSLock()
  private let clock: () -> TimeInterval
  private let utc: () -> Date
  private var sessionHash: String?
  private var start: TimeInterval?
  private var entries: [Entry] = []
  private var streams: [StreamSnapshot] = []
  private var streamUpdatesDropped = 0
  static let streamCapacity = 16
  private var sequence = 0
  private var dropped = 0
  private var startedLate = false
  private var delegateAvailable = false
  private var disabled = false
  private var captureDuration = RemoteDataDiagnostics.duration
  static let capacity = 128
  static let duration: TimeInterval = 120

  init(clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    utc: @escaping () -> Date = { Date() }) {
    self.clock = clock
    self.utc = utc
  }

  func bind(sessionHash: String) {
    lock.lock(); defer { lock.unlock() }
    // Hashes are generated from the exact session string by the DATA owner.
    guard sessionHash.range(of: "^[a-f0-9]{16}$", options: .regularExpression) != nil else { return }
    self.sessionHash = sessionHash
  }

  @discardableResult
  func enable(startedLate: Bool, delegateAvailable: Bool, duration: TimeInterval = RemoteDataDiagnostics.duration) -> Bool {
    lock.lock()
    if let start {
      let available = !disabled && clock() - start <= captureDuration
      lock.unlock()
      return available
    }
    captureDuration = max(0, min(Self.duration, duration))
    start = clock()
    self.startedLate = startedLate
    self.delegateAvailable = delegateAvailable
    lock.unlock()
    record(.captureStarted)
    return true
  }

  func disable() { lock.lock(); disabled = true; lock.unlock() }

  func record(_ event: Event, streamId: String? = nil, cause: Cause? = nil, error: Error? = nil,
    closeCode: Int? = nil, path: Path? = nil,
    sentBytes: Int? = nil, receivedBytes: Int? = nil, deliveredBytes: Int? = nil) {
    lock.lock(); defer { lock.unlock() }
    guard let start, !disabled else { return }
    let elapsed = max(0, clock() - start)
    guard elapsed <= captureDuration else { return }
    sequence += 1
    let value = error.map { $0 as NSError }
    let domains: Set<String> = ["NSURLErrorDomain", "kCFErrorDomainCFNetwork",
      "NSOSStatusErrorDomain", "NSPOSIXErrorDomain", "NSCocoaErrorDomain", "kCFErrorDomainSSL"]
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let entry = Entry(sequence: sequence, utc: formatter.string(from: utc()),
      elapsedMs: Int(elapsed * 1000), event: event, streamId: streamId, cause: cause,
      errorDomain: value.map { domains.contains($0.domain) ? $0.domain : "OtherErrorDomain" },
      errorCode: value?.code, closeCode: closeCode, path: path,
      sentBytes: sentBytes, receivedBytes: receivedBytes, deliveredBytes: deliveredBytes)
    // Preserve the start of the failure sequence; a tail-only buffer could
    // silently turn cancellation-first into failure-first.
    if entries.count < Self.capacity { entries.append(entry) } else { dropped += 1 }
  }

  // The recorder owns value snapshots, never live streams or payload buffers.
  // Freeze at the same deadline as events, including exports made after teardown.
  func retainStream(_ stream: StreamSnapshot) {
    lock.lock(); defer { lock.unlock() }
    guard let start, !disabled, clock() - start <= captureDuration,
      stream.streamId.range(of: "^[A-F0-9]{32}$", options: .regularExpression) != nil,
      stream.outgoingTLSRecords.count <= 8, stream.incomingTLSRecords.count <= 8,
      (stream.outgoingTLSRecords + stream.incomingTLSRecords).allSatisfy({ (20...23).contains($0) }),
      stream.firstHandshake == "none" || stream.firstHandshake == "hrr"
        || UInt8(stream.firstHandshake) != nil
    else { return }
    if let index = streams.firstIndex(where: { $0.streamId == stream.streamId }) {
      streams[index] = stream
    } else if streams.count < Self.streamCapacity {
      streams.append(stream)
    } else {
      streamUpdatesDropped += 1
    }
  }

  func export() -> String? {
    lock.lock(); defer { lock.unlock() }
    guard let start else { return nil }
    let snapshot = Snapshot(generation: generation, sessionHash: sessionHash,
      startedLate: startedLate, delegateAvailable: delegateAvailable,
      captureLimitMs: Int(captureDuration * 1000),
      expired: clock() - start > captureDuration, dropped: dropped, events: entries,
      streams: streams, streamUpdatesDropped: streamUpdatesDropped)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(snapshot) else { return nil }
    return String(data: data, encoding: .utf8)
  }
}

#if canImport(Darwin)
final class RemoteDataDiagnosticDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  let diagnostics: RemoteDataDiagnostics
  init(_ diagnostics: RemoteDataDiagnostics) { self.diagnostics = diagnostics }
  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?) { diagnostics.record(.socketOpen) }
  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    diagnostics.record(.socketClose, closeCode: closeCode.rawValue)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    diagnostics.record(.taskCompleted, error: error)
  }
}
#endif
