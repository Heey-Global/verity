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

    init(_ connection: NWConnection) { self.connection = connection }
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

  var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !stopped && listener != nil && usedIds.count < 4_096
  }

  var isExhausted: Bool { lock.withLock { usedIds.count >= 4_096 } }
  var isStopped: Bool { lock.withLock { stopped } }

  init(dataURL: URL, coreURL: URL) throws {
    guard dataURL.scheme == "wss", dataURL.path == "/data", dataURL.query == nil,
      dataURL.fragment == nil, dataURL.user == nil, dataURL.password == nil,
      coreURL.scheme == "https", coreURL.user == nil, coreURL.password == nil,
      let host = coreURL.host, !host.isEmpty
    else { throw RemoteSmokeError.invalidInput }
    expectedHost = host.hasPrefix("[") && host.hasSuffix("]")
      ? String(host.dropFirst().dropLast()) : host
    expectedPort = coreURL.port ?? 443
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 15
    outer = URLSession(configuration: configuration)
    socket = outer.webSocketTask(with: dataURL)
    socket.maximumMessageSize = 96 * 1024
    writer = Writer(socket)
  }

  func start(ticket: String, sessionId: String) async throws -> Int {
    guard ticket.range(of: "^[A-Za-z0-9_-]{1,512}$", options: .regularExpression) != nil,
      sessionId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
    else { throw RemoteSmokeError.invalidInput }
    socket.resume()
    let timeout = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 15_000_000_000)
      if !Task.isCancelled { self?.stop() }
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
      return port
    } catch {
      stop()
      throw error
    }
  }

  func stop() {
    lock.lock()
    guard !stopped else { lock.unlock(); return }
    stopped = true
    let connections = streams.values.map(\.connection)
    for stream in streams.values { stream.closed = true }
    streams.removeAll()
    sessionPendingBytes = 0
    pendingLocal = 0
    listener?.cancel()
    listener = nil
    lock.unlock()
    for connection in connections { connection.cancel() }
    reader?.cancel()
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
    } catch { stop() }
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
      lock.withLock { stream.incomingEnded = true }
      enqueue(Data(), to: stream, id: id, complete: true)
    case "stream.reset":
      guard Set(frame.keys) == Set(["type", "streamId", "code"]),
        let code = frame["code"] as? String,
        ["protocol_error", "concurrency_limit", "upstream_error", "timeout"].contains(code)
      else { throw RemoteSmokeError.invalidFrame }
      drop(id)
    default: throw RemoteSmokeError.invalidFrame
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

  @discardableResult
  private func drop(_ id: String) -> Bool {
    lock.lock()
    let stream = streams.removeValue(forKey: id)
    if let stream {
      stream.closed = true
      sessionPendingBytes -= stream.pendingBytes
    }
    // Retire only after existing WebSockets and transfers have drained.
    let exhausted = stream != nil && usedIds.count >= 4_096 && streams.isEmpty
    lock.unlock()
    stream?.worker?.cancel()
    stream?.connection.cancel()
    if exhausted { stop() }
    return stream != nil
  }

  private func reset(_ id: String, code: String) async {
    guard drop(id) else { return }
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
      let greeting = try await read(connection, count: 2)
      guard greeting[0] == 5, greeting[1] > 0 else { throw RemoteSmokeError.invalidFrame }
      let methods = try await read(connection, count: Int(greeting[1]))
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
      timeout.cancel()
      try await reserveStreamSlot()
      reserved = true
      let id = UUID().uuidString.replacingOccurrences(of: "-", with: "")
      let stream = Stream(connection)
      let available = lock.withLock {
        reservedSlots -= 1
        reserved = false
        let available = !stopped && streams.count < 8 && usedIds.count < 4_096
        if available {
          streams[id] = stream
          usedIds.insert(id)
          openedId = id
        }
        return available
      }
      guard available else { throw RemoteSmokeError.limitReached }
      try await write(Data([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), to: connection)
      try await writer.send(["type": "stream.open", "streamId": id, "channel": "remote", "meta": [:]])
      stream.worker = Task { [weak self] in
        guard let self else { return }
        do { try await self.pumpLocal(stream, id: id) }
        catch { await self.reset(id, code: "upstream_error") }
      }
    } catch {
      if let openedId { drop(openedId) }
      connection.cancel()
    }
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
        lock.withLock { stream.outgoingEnded = true }
        try await writer.send(["type": "stream.end", "streamId": id])
        finish(id, stream)
        return
      }
      try await writer.send(["type": "stream.data", "streamId": id,
        "seq": stream.outgoingSequence, "payload": bytes.base64EncodedString()])
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
