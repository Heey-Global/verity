internal import ExpoModulesCore
import Darwin
import Foundation
import Network

private enum RemoteSmokeError: Error {
  case invalidInput
  case invalidFrame
  case closed
  case limitReached
}

private func matchesIP(_ bytes: Data, host: String, family: Int32) -> Bool {
  if family == AF_INET {
    var address = in_addr()
    guard host.withCString({ inet_pton(AF_INET, $0, &address) }) == 1 else { return false }
    return withUnsafeBytes(of: address) { Data($0) } == bytes
  }
  var address = in6_addr()
  guard host.withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { return false }
  return withUnsafeBytes(of: address) { Data($0) } == bytes
}

// One bounded request only. The production app transport is intentionally not
// selected by this module while the paired device path is still being tested.
@available(iOS 17.0, macOS 14.0, *)
private final class RemoteSmokeTunnel {
  private static let maxBytes = 1024 * 1024
  private let ticket: String
  private let sessionId: String
  private let expectedHost: String
  private let expectedPort: Int
  private let outer: URLSession
  private let socket: URLSessionWebSocketTask
  private let queue = DispatchQueue(label: "verity.remote-smoke")
  private var listener: NWListener?
  private var local: NWConnection?
  private var worker: Task<Void, Never>?

  init(dataURL: URL, ticket: String, sessionId: String, coreURL: URL) throws {
    guard
      dataURL.scheme == "wss", dataURL.path == "/data", dataURL.query == nil,
      dataURL.fragment == nil, dataURL.user == nil, dataURL.password == nil,
      coreURL.scheme == "https", coreURL.user == nil, coreURL.password == nil,
      let host = coreURL.host, !host.isEmpty,
      ticket.range(of: "^[A-Za-z0-9_-]{1,512}$", options: .regularExpression) != nil,
      sessionId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
    else { throw RemoteSmokeError.invalidInput }
    self.ticket = ticket
    self.sessionId = sessionId
    expectedHost = host.hasPrefix("[") && host.hasSuffix("]")
      ? String(host.dropFirst().dropLast()) : host
    expectedPort = coreURL.port ?? 443
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 15
    outer = URLSession(configuration: configuration)
    socket = outer.webSocketTask(with: dataURL)
    socket.maximumMessageSize = 96 * 1024
  }

  private func send(_ frame: [String: Any]) async throws {
    let data = try JSONSerialization.data(withJSONObject: frame)
    guard data.count <= 96 * 1024, let text = String(data: data, encoding: .utf8)
    else { throw RemoteSmokeError.limitReached }
    try await socket.send(.string(text))
  }

  private func receive() async throws -> [String: Any] {
    guard case .string(let text) = try await socket.receive(),
      let raw = text.data(using: .utf8), raw.count <= 96 * 1024,
      let value = try JSONSerialization.jsonObject(with: raw) as? [String: Any]
    else { throw RemoteSmokeError.invalidFrame }
    return value
  }

  func attach() async throws {
    socket.resume()
    let timeout = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 15_000_000_000)
      if !Task.isCancelled { self?.socket.cancel(with: .goingAway, reason: nil) }
    }
    defer { timeout.cancel() }
    try await send(["type": "attach", "ticket": ticket])
    let frame = try await receive()
    guard Set(frame.keys) == Set(["type", "sessionId", "capability"]),
      frame["type"] as? String == "attached",
      frame["sessionId"] as? String == sessionId,
      frame["capability"] as? String == "remote-control-v1"
    else { throw RemoteSmokeError.invalidFrame }
  }

  func start() async throws -> NWEndpoint.Port {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { connection.cancel(); return }
      guard self.local == nil else { connection.cancel(); return }
      self.local = connection
      connection.start(queue: self.queue)
      self.worker = Task {
        do { try await self.serve(connection) } catch { connection.cancel() }
      }
    }
    return try await withCheckedThrowingContinuation { continuation in
      var completed = false
      listener.stateUpdateHandler = { [weak listener] state in
        guard !completed else { return }
        switch state {
        case .ready:
          completed = true
          if let port = listener?.port { continuation.resume(returning: port) }
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
      listener.start(queue: queue)
    }
  }

  func stop() {
    queue.async {
      self.listener?.cancel()
      self.worker?.cancel()
      self.local?.cancel()
      self.socket.cancel(with: .goingAway, reason: nil)
      self.outer.invalidateAndCancel()
    }
  }

  private func read(_ connection: NWConnection, count: Int) async throws -> Data {
    var result = Data()
    while result.count < count {
      let chunk = try await receive(connection, maximum: count - result.count)
      guard !chunk.isEmpty else { throw RemoteSmokeError.closed }
      result.append(chunk)
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

  private func write(_ data: Data, to connection: NWConnection, complete: Bool = false) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      connection.send(content: complete ? nil : data, contentContext: .defaultMessage,
        isComplete: complete,
        completion: .contentProcessed { error in
          if let error { continuation.resume(throwing: error) }
          else { continuation.resume() }
        })
    }
  }

  private func serve(_ connection: NWConnection) async throws {
    let greeting = try await read(connection, count: 2)
    guard greeting[0] == 5, greeting[1] > 0 else { throw RemoteSmokeError.invalidFrame }
    let methods = try await read(connection, count: Int(greeting[1]))
    guard methods.contains(0) else { throw RemoteSmokeError.invalidFrame }
    try await write(Data([5, 0]), to: connection)
    let request = try await read(connection, count: 4)
    guard request.prefix(3) == Data([5, 1, 0]) else { throw RemoteSmokeError.invalidFrame }
    let destinationMatches: Bool
    switch request[3] {
    case 1:
      destinationMatches = matchesIP(try await read(connection, count: 4), host: expectedHost,
        family: AF_INET)
    case 3:
      let length = try await read(connection, count: 1)
      let hostname = try await read(connection, count: Int(length[0]))
      destinationMatches = String(data: hostname, encoding: .utf8)?.lowercased()
        == expectedHost.lowercased()
    case 4:
      destinationMatches = matchesIP(try await read(connection, count: 16), host: expectedHost,
        family: AF_INET6)
    default:
      throw RemoteSmokeError.invalidFrame
    }
    let port = try await read(connection, count: 2)
    let requestedPort = (Int(port[0]) << 8) | Int(port[1])
    guard destinationMatches, requestedPort == expectedPort
    else { throw RemoteSmokeError.invalidInput }
    try await write(Data([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), to: connection)

    let streamId = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    try await send(["type": "stream.open", "streamId": streamId, "channel": "remote", "meta": [:]])
    do {
      try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask { try await self.pumpLocal(connection, streamId: streamId) }
        group.addTask { try await self.pumpRemote(connection, streamId: streamId) }
        do {
          while try await group.next() != nil {}
        } catch {
          // Cancelling both I/O endpoints releases a peer pump blocked in receive.
          connection.cancel()
          socket.cancel(with: .protocolError, reason: nil)
          group.cancelAll()
          throw error
        }
      }
    } catch {
      connection.cancel()
      throw error
    }
    connection.cancel()
  }

  private func pumpLocal(_ connection: NWConnection, streamId: String) async throws {
    var sequence = 0
    var total = 0
    while !Task.isCancelled {
      let bytes = try await receive(connection, maximum: 16 * 1024)
      if bytes.isEmpty {
        try await send(["type": "stream.end", "streamId": streamId])
        return
      }
      total += bytes.count
      guard total <= Self.maxBytes else { throw RemoteSmokeError.limitReached }
      try await send([
        "type": "stream.data", "streamId": streamId, "seq": sequence,
        "payload": bytes.base64EncodedString(),
      ])
      sequence += 1
    }
  }

  private func pumpRemote(_ connection: NWConnection, streamId: String) async throws {
    var sequence = 0
    var total = 0
    while !Task.isCancelled {
      let frame = try await receive()
      guard frame["streamId"] as? String == streamId,
        let type = frame["type"] as? String
      else { throw RemoteSmokeError.invalidFrame }
      if type == "stream.end" {
        guard Set(frame.keys) == Set(["type", "streamId"])
        else { throw RemoteSmokeError.invalidFrame }
        try await write(Data(), to: connection, complete: true)
        return
      }
      guard type == "stream.data",
        Set(frame.keys) == Set(["type", "streamId", "seq", "payload"]),
        frame["seq"] as? Int == sequence,
        let payload = frame["payload"] as? String,
        let bytes = Data(base64Encoded: payload), bytes.base64EncodedString() == payload,
        bytes.count <= 64 * 1024
      else { throw RemoteSmokeError.invalidFrame }
      total += bytes.count
      guard total <= Self.maxBytes else { throw RemoteSmokeError.limitReached }
      try await write(bytes, to: connection)
      sequence += 1
    }
  }
}

class VerityRemoteControlSmoke: Module {
  public func definition() -> ModuleDefinition {
    Name("VerityRemoteControlSmoke")

    AsyncFunction("requestOnce") {
      (dataURLText: String, ticket: String, sessionId: String, coreURLText: String, corePin: String) async throws
        -> [String: Any] in
      guard #available(iOS 17.0, macOS 14.0, *) else { throw RemoteSmokeError.invalidInput }
      guard let dataURL = URL(string: dataURLText), let coreURL = URL(string: coreURLText),
        coreURL.scheme == "https", coreURL.user == nil, coreURL.password == nil
      else { throw RemoteSmokeError.invalidInput }
      let tunnel = try RemoteSmokeTunnel(
        dataURL: dataURL, ticket: ticket, sessionId: sessionId, coreURL: coreURL)
      defer { tunnel.stop() }
      try await tunnel.attach()
      let port = try await tunnel.start()
      let configuration = URLSessionConfiguration.ephemeral
      configuration.timeoutIntervalForRequest = 20
      configuration.timeoutIntervalForResource = 30
      configuration.proxyConfigurations = [
        ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: port))
      ]
      let delegate = try CertificatePinDelegate(pin: corePin, origin: coreURL)
      let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
      defer { session.invalidateAndCancel() }
      let (body, response) = try await session.data(from: coreURL)
      guard let http = response as? HTTPURLResponse else { throw RemoteSmokeError.invalidFrame }
      return ["status": http.statusCode, "bodyBase64": body.base64EncodedString()]
    }
  }
}
