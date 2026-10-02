import Darwin
import Foundation
import Network

// One /data attachment carries every app request. The local SOCKS listener only
// accepts the paired Core host and port; the URLSession TLS delegate still pins
// the Core certificate after the tunnel has forwarded the encrypted bytes.
@available(iOS 17.0, macOS 14.0, *)
final class RemoteAppTunnel: @unchecked Sendable {
  private actor Writer {
    private let socket: URLSessionWebSocketTask
    private var previous: Task<Void, Error>?

    init(_ socket: URLSessionWebSocketTask) { self.socket = socket }

    func send(_ frame: [String: Any]) async throws {
      let data = try JSONSerialization.data(withJSONObject: frame)
      guard data.count <= 96 * 1024, let text = String(data: data, encoding: .utf8)
      else { throw RemoteSmokeError.limitReached }
      let predecessor = previous
      let task = Task {
        if let predecessor { try await predecessor.value }
        try await socket.send(.string(text))
      }
      previous = task
      try await task.value
    }
  }

  private final class Stream {
    let connection: NWConnection
    var incomingSequence = 0
    var outgoingSequence = 0
    var incomingEnded = false
    var incomingFlushed = false
    var outgoingEnded = false
    var pendingBytes = 0
    var incomingWrite: Task<Void, Never>?
    var closed = false
    var worker: Task<Void, Never>?
    // Armed when the first local bytes have gone out; Core's TLS reply to a
    // ClientHello arrives within milliseconds, so a stream still without any
    // reply after the deadline is on an attachment that has gone dead without
    // saying so. Ending the attachment lets the app open a fresh one instead
    // of waiting out every request's own timeout.
    var stallWatch: Task<Void, Never>?
    var sentBytes = 0
    var receivedBytes = 0
    var deliveredBytes = 0
    // Record-level trace of the pinned TLS exchange, never its contents: which
    // proxy dialect opened the stream, the TLS record types seen in each
    // direction, the first handshake message from Core, and which side ended
    // the stream. On a device this is the only view of a handshake that the
    // app's TLS client abandons without reporting why.
    let proxy: String
    /** First characters of the stream ID, so Core's record of the same stream can be matched. */
    let key: String
    let openedAt = Date()
    var firstRemoteAt: Date?
    var endedAt: Date?
    var endedBy = "open"
    var outgoing = RecordTrace()
    var incoming = RecordTrace()

    init(_ connection: NWConnection, proxy: String, key: String) {
      self.connection = connection
      self.proxy = proxy
      self.key = key
    }

    func noteRecord(_ data: Data, incoming isIncoming: Bool) {
      if isIncoming { incoming.feed(data) } else { outgoing.feed(data) }
    }

    var traceToken: String {
      // Clamped to the widths the app accepts; a long-lived stream must not
      // push the whole trace out of the visible summary.
      let ended = endedAt ?? Date()
      let millis: (Date, Int) -> Int = { date, cap in
        max(0, min(Int(date.timeIntervalSince(self.openedAt) * 1000), cap))
      }
      let firstRemote = firstRemoteAt.map { String(millis($0, 9_999_999)) } ?? "none"
      let list: ([UInt8]) -> String = {
        $0.isEmpty ? "none" : $0.map { String($0) }.joined(separator: "-")
      }
      return "k\(key).up\(min(sentBytes, 999_999_999)).dn\(min(receivedBytes, 999_999_999))"
        + ".fo\(min(outgoingSequence, 9_999_999)).fi\(min(incomingSequence, 9_999_999)).t\(firstRemote)"
        + ".d\(millis(ended, 99_999_999)).\(endedBy).p\(proxy)"
        + ".o\(list(outgoing.types)).i\(list(incoming.types)).h\(incoming.firstHandshake)"
    }
  }

  // Follows TLS record boundaries across socket reads and frames, so a record
  // split over two chunks is counted once and a chunk starting mid-record is
  // not mistaken for a new one. Keeps only record types and the first
  // handshake message; the 38-byte prefix needed to tell a ServerHello from a
  // HelloRetryRequest is discarded once classified.
  struct RecordTrace {
    private static let hrrRandom: [UInt8] = [
      0xCF, 0x21, 0xAD, 0x74, 0xE5, 0x9A, 0x61, 0x11, 0xBE, 0x1D, 0x8C, 0x02, 0x1E, 0x65,
      0xB8, 0x91, 0xC2, 0xA2, 0x11, 0x16, 0x7A, 0xBB, 0x8C, 0x5E, 0x07, 0x9E, 0x09, 0xE2,
      0xC8, 0xA8, 0x33, 0x9C,
    ]
    private var header: [UInt8] = []
    private var remaining = 0
    private var prefix: [UInt8] = []
    private var capturePrefix = false
    private var desynced = false
    private(set) var types: [UInt8] = []
    private(set) var firstHandshake = "none"

    mutating func feed(_ data: Data) {
      guard !desynced else { return }
      var index = data.startIndex
      while index < data.endIndex {
        if remaining > 0 {
          let step = min(remaining, data.endIndex - index)
          if capturePrefix {
            let take = min(step, 38 - prefix.count)
            prefix.append(contentsOf: data[index..<index + take])
          }
          remaining -= step
          index += step
          if capturePrefix, prefix.count >= 38 || remaining == 0 { classifyPrefix() }
          continue
        }
        header.append(data[index])
        index += 1
        guard header.count == 5 else { continue }
        let type = header[0]
        guard type >= 20, type <= 23 else {
          desynced = true
          return
        }
        remaining = Int(header[3]) << 8 | Int(header[4])
        header = []
        if types.count < 8 { types.append(type) }
        if type == 22, firstHandshake == "none", !capturePrefix { capturePrefix = true }
        if remaining == 0, capturePrefix { classifyPrefix() }
      }
    }

    private mutating func classifyPrefix() {
      capturePrefix = false
      guard let message = prefix.first else { return }
      let retry = message == 2 && prefix.count >= 38 && Array(prefix[6..<38]) == Self.hrrRandom
      firstHandshake = retry ? "hrr" : String(message)
      prefix = []
    }
  }

  private let expectedHost: String
  private let expectedPort: Int
  private let outer: URLSession
  private let socket: URLSessionWebSocketTask
  private let writer: Writer
  private let queue = DispatchQueue(label: "verity.remote-app")
  private let lock = NSLock()
  private var listener: NWListener?
  private var reader: Task<Void, Never>?
  private var streams: [String: Stream] = [:]
  private var usedIds = Set<String>()
  private var sessionPendingBytes = 0
  private var pendingLocal = 0
  private var reservedSlots = 0
  private var stopped = false
  private var stopReasonText: String?
  private var heartbeat: Task<Void, Never>?
  private var unansweredPingSince: Date?
  private var localConnections = 0
  private var openedStreams = 0
  private var receivedStreamFrames = 0
  private var lastStreamEvent = "none"
  private var diagnosticSession = "none"
  private var sentBytes = 0
  private var receivedBytes = 0
  private var deliveredBytes = 0
  private var localResets = 0
  private var remoteResets = 0
  private var lastReset = "none"
  // At most three finished streams, each holding one cancelled connection;
  // the summary stays readable after the tunnel has stopped.
  private var recentStreams: [Stream] = []

  // Counts and a fixed event name only: diagnostics must not expose URLs, tickets, or stream data.
  var diagnosticSummary: String {
    lock.withLock {
      let traces = recentStreams.enumerated()
        .map { "s\($0.offset + 1)=\($0.element.traceToken)" }.joined(separator: ";")
      return "local=\(localConnections), opened=\(openedStreams), received=\(receivedStreamFrames), last=\(lastStreamEvent), sentBytes=\(sentBytes), receivedBytes=\(receivedBytes), deliveredBytes=\(deliveredBytes), localResets=\(localResets), remoteResets=\(remoteResets), lastReset=\(lastReset)"
        + (traces.isEmpty ? "" : ", streams=\(traces)")
    }
  }

  var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !stopped && listener != nil && usedIds.count < 4_096
  }

  var isExhausted: Bool { lock.withLock { usedIds.count >= 4_096 } }
  var isStopped: Bool { lock.withLock { stopped } }
  /// Why the attachment ended. Without it a dropped tunnel reaches the user only as a generic
  /// transport error on whichever request happened to run next.
  var stopReason: String? { lock.withLock { stopReasonText } }

  init(dataURL: URL, coreURL: URL, outerSession: URLSession? = nil) throws {
    guard dataURL.scheme == "wss", dataURL.path == "/data", dataURL.query == nil,
      dataURL.fragment == nil, dataURL.user == nil, dataURL.password == nil,
      coreURL.scheme == "https", coreURL.user == nil, coreURL.password == nil,
      let host = coreURL.host, !host.isEmpty
    else { throw RemoteSmokeError.invalidInput }
    expectedHost = host.hasPrefix("[") && host.hasSuffix("]")
      ? String(host.dropFirst().dropLast()) : host
    expectedPort = coreURL.port ?? 443
    let configuration = URLSessionConfiguration.ephemeral
    // On a WebSocket task the request timeout is an idle timeout: a receive that
    // waits longer fails and ends the whole attachment. The tunnel is idle for as
    // long as the user reads, so liveness comes from the ping loop below instead.
    // `start` bounds the attachment itself.
    configuration.timeoutIntervalForRequest = 7 * 24 * 60 * 60
    configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
    outer = outerSession ?? URLSession(configuration: configuration)
    socket = outer.webSocketTask(with: dataURL)
    socket.maximumMessageSize = 96 * 1024
    writer = Writer(socket)
  }

  func start(ticket: String, sessionId: String) async throws -> Int {
    guard ticket.range(of: "^[A-Za-z0-9_-]{1,512}$", options: .regularExpression) != nil,
      sessionId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
    else { throw RemoteSmokeError.invalidInput }
    lock.withLock { diagnosticSession = sessionId }
    socket.resume()
    let timeout = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 15_000_000_000)
      if !Task.isCancelled { self?.stop(reason: "attachment timed out") }
    }
    defer { timeout.cancel() }
    do {
      try await writer.send(["type": "attach", "ticket": ticket])
      let frame = try await receiveFrame()
      guard Set(frame.keys) == Set(["type", "sessionId", "capability"]),
        frame["type"] as? String == "attached", frame["sessionId"] as? String == sessionId,
        frame["capability"] as? String == "remote-control-v1"
      else { throw RemoteSmokeError.invalidFrame }

      let parameters = NWParameters.tcp
      parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
      let listener = try NWListener(using: parameters)
      lock.withLock { self.listener = listener }
      let port = try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Int, Error>) in
        var completed = false
        listener.stateUpdateHandler = { [weak listener] state in
          guard !completed else { return }
          switch state {
          case .ready:
            completed = true
            if let port = listener?.port { continuation.resume(returning: Int(port.rawValue)) }
            else { continuation.resume(throwing: RemoteSmokeError.closed) }
          case .failed(let error):
            completed = true
            continuation.resume(throwing: error)
          case .cancelled:
            completed = true
            continuation.resume(throwing: RemoteSmokeError.closed)
          default: break
          }
        }
        listener.newConnectionHandler = { [weak self] connection in
          guard let self else { connection.cancel(); return }
          let admitted = self.lock.withLock {
            if self.stopped || self.pendingLocal >= 16 { return false }
            self.pendingLocal += 1
            self.localConnections += 1
            self.lastStreamEvent = "local_connected"
            return true
          }
          guard admitted else { connection.cancel(); return }
          connection.start(queue: self.queue)
          Task { await self.accept(connection) }
        }
        listener.start(queue: queue)
      }
      reader = Task { [weak self] in
        guard let self else { return }
        await self.readFrames()
      }
      startHeartbeat()
      return port
    } catch {
      stop(reason: "attachment failed: \(error)")
      throw error
    }
  }

  func stop(reason: String = "stopped by app") {
    lock.lock()
    guard !stopped else { lock.unlock(); return }
    stopped = true
    stopReasonText = reason
    let connections = streams.values.map(\.connection)
    for (id, stream) in streams {
      logStream(id, stream, event: "session_stopped")
      stream.closed = true
      stream.stallWatch?.cancel()
      if stream.endedBy == "open" { stream.endedBy = "stopped"; stream.endedAt = Date() }
    }
    streams.removeAll()
    sessionPendingBytes = 0
    pendingLocal = 0
    listener?.cancel()
    listener = nil
    lock.unlock()
    NSLog("Verity remote tunnel stopped: %@", reason)
    for connection in connections { connection.cancel() }
    reader?.cancel()
    lock.withLock { heartbeat }?.cancel()
    socket.cancel(with: .goingAway, reason: nil)
    outer.invalidateAndCancel()
  }

  private func receiveFrame() async throws -> [String: Any] {
    guard case .string(let text) = try await socket.receive(),
      let bytes = text.data(using: .utf8), bytes.count <= 96 * 1024,
      let frame = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
    else { throw RemoteSmokeError.invalidFrame }
    return frame
  }

  private func readFrames() async {
    do {
      while !Task.isCancelled {
        let frame = try await receiveFrame()
        try await handle(frame)
      }
    } catch { stop(reason: "data socket failed: \(error)") }
  }

  // Mirrors the Uplink side of the data heartbeat: one outstanding ping, and the
  // attachment ends once it has gone unanswered for more than 45 seconds, noticed
  // on the next 15-second tick (so within 60 seconds). Measured from the
  // ping rather than the last pong, so a suspension in the background does not
  // by itself count as a dead socket.
  private func startHeartbeat() {
    let task = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 15_000_000_000)
        guard !Task.isCancelled, let self else { return }
        let now = Date()
        let (expired, due) = self.lock.withLock { () -> (Bool, Bool) in
          guard let since = self.unansweredPingSince else {
            self.unansweredPingSince = now
            return (false, true)
          }
          return (now.timeIntervalSince(since) > 45, false)
        }
        if expired {
          self.stop(reason: "heartbeat timeout")
          return
        }
        guard due else { continue }
        self.socket.sendPing { [weak self] error in
          guard let self else { return }
          if let error { self.stop(reason: "heartbeat failed: \(error)") }
          else { self.lock.withLock { self.unansweredPingSince = nil } }
        }
      }
    }
    // The reader may already have stopped the tunnel; that stop could not see this task.
    let alreadyStopped = lock.withLock { () -> Bool in
      if stopped { return true }
      heartbeat = task
      return false
    }
    if alreadyStopped { task.cancel() }
  }

  private func handle(_ frame: [String: Any]) async throws {
    guard let type = frame["type"] as? String,
      let id = frame["streamId"] as? String,
      id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
    else { throw RemoteSmokeError.invalidFrame }
    let (stream, ignored) = lock.withLock {
      let stream = streams[id]
      return (stream, usedIds.contains(id) && stream == nil)
    }
    if ignored {
      if type == "stream.end" && Set(frame.keys) == Set(["type", "streamId"]) { return }
      if type == "stream.reset" && Set(frame.keys) == Set(["type", "streamId", "code"]),
        let code = frame["code"] as? String,
        ["protocol_error", "concurrency_limit", "upstream_error", "timeout"].contains(code)
      { return }
      if type == "stream.data" && Set(frame.keys) == Set(["type", "streamId", "seq", "payload"]),
        let sequence = frame["seq"] as? Int, sequence >= 0,
        let payload = frame["payload"] as? String,
        let data = Data(base64Encoded: payload), data.base64EncodedString() == payload,
        data.count <= 64 * 1024
      { return }
    }
    guard let stream else { throw RemoteSmokeError.invalidFrame }
    switch type {
    case "stream.data":
      guard Set(frame.keys) == Set(["type", "streamId", "seq", "payload"]),
        !stream.incomingEnded, frame["seq"] as? Int == stream.incomingSequence,
        let payload = frame["payload"] as? String,
        let data = Data(base64Encoded: payload), data.base64EncodedString() == payload,
        data.count <= 64 * 1024
      else { throw RemoteSmokeError.invalidFrame }
      lock.withLock {
        let first = stream.receivedBytes == 0 && !data.isEmpty
        if first {
          stream.firstRemoteAt = Date()
          stream.stallWatch?.cancel()
          stream.stallWatch = nil
        }
        stream.noteRecord(data, incoming: true)
        stream.receivedBytes += data.count
        receivedBytes += data.count
        if first { logStream(id, stream, event: "first_remote_data") }
      }
      stream.incomingSequence += 1
      let accepted = lock.withLock {
        guard !stream.closed,
          stream.pendingBytes + data.count <= 256 * 1024,
          sessionPendingBytes + data.count <= 1024 * 1024
        else { return false }
        stream.pendingBytes += data.count
        sessionPendingBytes += data.count
        return true
      }
      if !accepted {
        await reset(id, code: "upstream_error")
        return
      }
      enqueue(data, to: stream, id: id)
    case "stream.end":
      guard Set(frame.keys) == Set(["type", "streamId"]), !stream.incomingEnded
      else { throw RemoteSmokeError.invalidFrame }
      lock.withLock {
        stream.incomingEnded = true
        if stream.endedBy == "open" { stream.endedBy = "remote"; stream.endedAt = Date() }
      }
      enqueue(Data(), to: stream, id: id, complete: true)
    case "stream.reset":
      guard Set(frame.keys) == Set(["type", "streamId", "code"]),
        let code = frame["code"] as? String,
        ["protocol_error", "concurrency_limit", "upstream_error", "timeout"].contains(code)
      else { throw RemoteSmokeError.invalidFrame }
      drop(id, reason: "remote_reset_\(code)")
    default: throw RemoteSmokeError.invalidFrame
    }
    lock.withLock {
      receivedStreamFrames += 1
      lastStreamEvent = "remote_\(type)"
    }
  }

  private func finish(_ id: String, _ stream: Stream) {
    if lock.withLock({ stream.incomingFlushed && stream.outgoingEnded }) { drop(id) }
  }

  private func enqueue(_ data: Data, to stream: Stream, id: String, complete: Bool = false) {
    let previous = stream.incomingWrite
    stream.incomingWrite = Task {
      if let previous { await previous.value }
      guard !Task.isCancelled else { return }
      let watchdog = Task { [weak self] in
        try? await Task.sleep(nanoseconds: 30_000_000_000)
        if !Task.isCancelled { await self?.reset(id, code: "timeout") }
      }
      defer { watchdog.cancel() }
      do {
        try await write(data, to: stream.connection, complete: complete)
        lock.withLock {
          if !stream.closed {
            let first = stream.deliveredBytes == 0 && !data.isEmpty
            stream.deliveredBytes += data.count
            deliveredBytes += data.count
            if first { logStream(id, stream, event: "first_local_data_delivered") }
            stream.pendingBytes -= data.count
            sessionPendingBytes -= data.count
          }
        }
        if complete {
          lock.withLock { stream.incomingFlushed = true }
          finish(id, stream)
        }
      } catch {
        if complete && lock.withLock({ stream.outgoingEnded }) {
          // Both peers have ended. A local socket that already closed cannot
          // accept a final write, but the remote stream has completed.
          drop(id)
        } else {
          await reset(id, code: "upstream_error")
        }
      }
    }
  }

  // Called under lock; events and reset codes are fixed locally, never payload text.
  private func logStream(_ id: String, _ stream: Stream, event: String) {
    NSLog("Verity remote stream session=%@ stream=%@ event=%@ sentBytes=%ld receivedBytes=%ld deliveredBytes=%ld",
      diagnosticSession, id, event, stream.sentBytes, stream.receivedBytes, stream.deliveredBytes)
  }

  @discardableResult
  private func drop(_ id: String, reason: String = "completed") -> Bool {
    lock.lock()
    let stream = streams.removeValue(forKey: id)
    if let stream {
      if reason.hasPrefix("local_reset_") { localResets += 1; lastReset = reason }
      if reason.hasPrefix("remote_reset_") { remoteResets += 1; lastReset = reason }
      if stream.endedBy == "open" {
        stream.endedBy = reason.contains("reset") ? "reset" : reason == "completed" ? "remote" : "stopped"
        stream.endedAt = Date()
      }
      logStream(id, stream, event: reason)
      stream.closed = true
      sessionPendingBytes -= stream.pendingBytes
    }
    // Retire only after existing WebSockets and transfers have drained.
    let exhausted = stream != nil && usedIds.count >= 4_096 && streams.isEmpty
    lock.unlock()
    stream?.worker?.cancel()
    stream?.stallWatch?.cancel()
    stream?.connection.cancel()
    if exhausted { stop(reason: "stream IDs exhausted") }
    return stream != nil
  }

  static let stallDeadlineSeconds: UInt64 = 10

  private func armStallWatch(_ stream: Stream, id: String) {
    // The attachment is judged, not the stream: a slow Core on one stream
    // while others keep receiving is not a dead socket.
    let receivedWhenArmed = lock.withLock { receivedBytes }
    let task = Task { [weak self] in
      try? await Task.sleep(nanoseconds: Self.stallDeadlineSeconds * 1_000_000_000)
      guard !Task.isCancelled, let self else { return }
      // Re-checked under the lock, including that this attachment is the one
      // still running; the instance attaches once, so the check is belt and braces.
      let stalled = self.lock.withLock {
        !self.stopped && !stream.closed && stream.receivedBytes == 0
          && self.receivedBytes == receivedWhenArmed
      }
      guard stalled else { return }
      self.lock.withLock { self.logStream(id, stream, event: "stalled") }
      self.stop(reason: "stall: no reply on a stream within \(Self.stallDeadlineSeconds) s")
    }
    let alreadyDone = lock.withLock { () -> Bool in
      if stream.closed || stream.receivedBytes > 0 { return true }
      stream.stallWatch = task
      return false
    }
    if alreadyDone { task.cancel() }
  }

  private func reset(_ id: String, code: String) async {
    guard drop(id, reason: "local_reset_\(code)") else { return }
    try? await writer.send(["type": "stream.reset", "streamId": id, "code": code])
  }

  private func accept(_ connection: NWConnection) async {
    var openedId: String?
    var reserved = false
    let timeout = Task {
      try? await Task.sleep(nanoseconds: 10_000_000_000)
      if !Task.isCancelled { connection.cancel() }
    }
    defer {
      timeout.cancel()
      lock.withLock {
        pendingLocal = max(0, pendingLocal - 1)
        if reserved { reservedSlots -= 1 }
      }
    }
    do {
      // The app's URLSession may dial this listener as a SOCKS5 or an HTTP
      // CONNECT proxy; both carry the same pinned TLS bytes and are held to the
      // same paired Core host and port.
      let first = try await read(connection, count: 1)
      let proxy: String
      if first[0] == 5 {
        proxy = "socks"
        let count = try await read(connection, count: 1)
        guard count[0] > 0 else { throw RemoteSmokeError.invalidFrame }
        let methods = try await read(connection, count: Int(count[0]))
        guard methods.contains(0) else { throw RemoteSmokeError.invalidFrame }
        try await write(Data([5, 0]), to: connection)
        let request = try await read(connection, count: 4)
        guard request.prefix(3) == Data([5, 1, 0]) else { throw RemoteSmokeError.invalidFrame }
        let matches: Bool
        switch request[3] {
        case 1:
          matches = matchesIP(try await read(connection, count: 4), host: expectedHost,
            family: AF_INET)
        case 3:
          let length = try await read(connection, count: 1)
          let hostname = try await read(connection, count: Int(length[0]))
          matches = String(data: hostname, encoding: .utf8)?.lowercased() == expectedHost.lowercased()
        case 4:
          matches = matchesIP(try await read(connection, count: 16), host: expectedHost,
            family: AF_INET6)
        default: throw RemoteSmokeError.invalidFrame
        }
        let port = try await read(connection, count: 2)
        guard matches, (Int(port[0]) << 8) | Int(port[1]) == expectedPort
        else { throw RemoteSmokeError.invalidInput }
      } else if first[0] == UInt8(ascii: "C") {
        proxy = "connect"
        let head = try await readConnectHead(connection, first: first)
        guard matchesConnectTarget(head) else { throw RemoteSmokeError.invalidInput }
      } else {
        throw RemoteSmokeError.invalidFrame
      }
      timeout.cancel()
      try await reserveStreamSlot()
      reserved = true
      let id = UUID().uuidString.replacingOccurrences(of: "-", with: "")
      let stream = Stream(connection, proxy: proxy, key: String(id.prefix(8)))
      let available = lock.withLock {
        reservedSlots -= 1
        reserved = false
        let available = !stopped && streams.count < 8 && usedIds.count < 4_096
        if available {
          streams[id] = stream
          usedIds.insert(id)
          openedId = id
          recentStreams.append(stream)
          if recentStreams.count > 3 { recentStreams.removeFirst() }
        }
        return available
      }
      guard available else { throw RemoteSmokeError.limitReached }
      try await write(
        proxy == "socks"
          ? Data([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
          : Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8),
        to: connection)
      try await writer.send(["type": "stream.open", "streamId": id, "channel": "remote", "meta": [:]])
      lock.withLock {
        openedStreams += 1
        lastStreamEvent = "stream_opened"
        logStream(id, stream, event: "opened")
      }
      stream.worker = Task { [weak self] in
        guard let self else { return }
        do { try await self.pumpLocal(stream, id: id) }
        catch { await self.reset(id, code: "upstream_error") }
      }
    } catch {
      lock.withLock { lastStreamEvent = "local_rejected" }
      if let openedId { drop(openedId, reason: "local_rejected") }
      connection.cancel()
    }
  }

  // Only the request head is read; the TLS bytes that follow the 200 reply
  // belong to the stream. Bounded so a client cannot hold the accept open.
  private func readConnectHead(_ connection: NWConnection, first: Data) async throws -> String {
    var head = first
    let terminator = Data("\r\n\r\n".utf8)
    while head.range(of: terminator) == nil {
      guard head.count < 4_096 else { throw RemoteSmokeError.invalidFrame }
      let bytes = try await receive(connection, maximum: 4_096 - head.count)
      guard !bytes.isEmpty else { throw RemoteSmokeError.closed }
      head.append(bytes)
    }
    guard let end = head.range(of: terminator), end.upperBound == head.endIndex,
      let text = String(data: head, encoding: .utf8)
    else { throw RemoteSmokeError.invalidFrame }
    return text
  }

  private func matchesConnectTarget(_ head: String) -> Bool {
    let parts = head.components(separatedBy: "\r\n")[0].split(separator: " ")
    guard parts.count == 3, parts[0] == "CONNECT", parts[2].hasPrefix("HTTP/1.") else { return false }
    let target = String(parts[1])
    guard let separator = target.lastIndex(of: ":"), let port = Int(target[target.index(after: separator)...])
    else { return false }
    var host = String(target[..<separator])
    if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
    guard port == expectedPort else { return false }
    if host.lowercased() == expectedHost.lowercased() { return true }
    // An IP-literal Core may be spelled differently by the client (IPv6 compression).
    for family in [AF_INET, AF_INET6] {
      let size = family == AF_INET ? 4 : 16
      var expected = [UInt8](repeating: 0, count: size)
      var given = [UInt8](repeating: 0, count: size)
      if expectedHost.withCString({ inet_pton(family, $0, &expected) }) == 1,
        host.withCString({ inet_pton(family, $0, &given) }) == 1
      { return expected == given }
    }
    return false
  }

  private func reserveStreamSlot() async throws {
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
      let result = lock.withLock { () -> Int in
        if stopped { return -1 }
        if usedIds.count + reservedSlots >= 4_096 { return -2 }
        if streams.count + reservedSlots >= 8 { return 0 }
        reservedSlots += 1
        return 1
      }
      if result == 1 { return }
      if result == -1 { throw RemoteSmokeError.closed }
      if result == -2 { throw RemoteSmokeError.limitReached }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    throw RemoteSmokeError.limitReached
  }

  private func pumpLocal(_ stream: Stream, id: String) async throws {
    while !Task.isCancelled {
      let bytes = try await receive(stream.connection, maximum: 16 * 1024)
      if bytes.isEmpty {
        lock.withLock {
          stream.outgoingEnded = true
          if stream.endedBy == "open" { stream.endedBy = "local"; stream.endedAt = Date() }
        }
        try await writer.send(["type": "stream.end", "streamId": id])
        finish(id, stream)
        return
      }
      try await writer.send(["type": "stream.data", "streamId": id,
        "seq": stream.outgoingSequence, "payload": bytes.base64EncodedString()])
      let first = lock.withLock { () -> Bool in
        let first = stream.sentBytes == 0
        stream.noteRecord(bytes, incoming: false)
        stream.sentBytes += bytes.count
        sentBytes += bytes.count
        if first { logStream(id, stream, event: "first_local_data_sent") }
        return first
      }
      if first { armStallWatch(stream, id: id) }
      stream.outgoingSequence += 1
    }
  }

  private func read(_ connection: NWConnection, count: Int) async throws -> Data {
    var result = Data()
    while result.count < count {
      let bytes = try await receive(connection, maximum: count - result.count)
      guard !bytes.isEmpty else { throw RemoteSmokeError.closed }
      result.append(bytes)
    }
    return result
  }

  private func receive(_ connection: NWConnection, maximum: Int) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      connection.receive(minimumIncompleteLength: 1, maximumLength: maximum) { data, _, _, error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume(returning: data ?? Data()) }
      }
    }
  }

  private func write(_ bytes: Data, to connection: NWConnection, complete: Bool = false) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      connection.send(content: complete ? nil : bytes,
        contentContext: complete ? .finalMessage : .defaultMessage,
        isComplete: complete, completion: .contentProcessed { error in
          if let error { continuation.resume(throwing: error) }
          else { continuation.resume() }
        })
    }
  }
}
