// Test-only transport spike; never linked into the application.
import Foundation
import Network

enum TunnelError: Error { case protocolViolation, closed }

@available(macOS 14.0, iOS 17.0, *)
final class NativeTunnel {
  private let queue = DispatchQueue(label: "verity.test.tunnel")
  private let listener: NWListener
  private let outer: URLSession
  private let outerDelegate: CertificatePinDelegate
  var outerFailure: String? { outerDelegate.failure }
  private let endpoint: URL
  private var clients: [UUID: NWConnection] = [:]
  private var workers: [UUID: Task<Void, Never>] = [:]

  init(endpoint: URL, pin: String) throws {
    guard endpoint.scheme == "wss" else { throw TunnelError.protocolViolation }
    self.endpoint = endpoint
    var origin = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
    origin.scheme = "https"
    let delegate = try CertificatePinDelegate(pin: pin, origin: origin.url!)
    outerDelegate = delegate
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 10
    outer = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
  }

  func start() async throws -> NWEndpoint.Port {
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { connection.cancel(); return }
      let id = UUID()
      self.clients[id] = connection
      connection.start(queue: self.queue)
      self.workers[id] = Task {
        do { try await self.serve(connection) } catch { /* Close both transport legs. */ }
        connection.cancel()
        self.queue.async {
          self.clients.removeValue(forKey: id)
          self.workers.removeValue(forKey: id)
        }
      }
    }
    return try await withCheckedThrowingContinuation { continuation in
      var completed = false
      listener.stateUpdateHandler = { [weak self] state in
        guard !completed else { return }
        switch state {
        case .ready:
          completed = true
          if let port = self?.listener.port { continuation.resume(returning: port) }
          else { continuation.resume(throwing: TunnelError.closed) }
        case .failed(let error):
          completed = true
          continuation.resume(throwing: error)
        case .cancelled:
          completed = true
          continuation.resume(throwing: TunnelError.closed)
        default: break
        }
      }
      listener.start(queue: queue)
    }
  }

  func stop() async {
    await withCheckedContinuation { continuation in
      queue.async {
        self.listener.cancel()
        self.workers.values.forEach { $0.cancel() }
        self.clients.values.forEach { $0.cancel() }
        self.outer.invalidateAndCancel()
        continuation.resume()
      }
    }
  }

  private func read(_ connection: NWConnection, count: Int) async throws -> Data {
    var result = Data()
    while result.count < count {
      let chunk = try await receive(connection, maximum: count - result.count)
      guard !chunk.isEmpty else { throw TunnelError.closed }
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

  private func send(_ data: Data, to connection: NWConnection) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      connection.send(content: data, completion: .contentProcessed { error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      })
    }
  }

  private func serve(_ connection: NWConnection) async throws {
    let greeting = try await read(connection, count: 2)
    guard greeting[0] == 5, greeting[1] > 0 else { throw TunnelError.protocolViolation }
    let methods = try await read(connection, count: Int(greeting[1]))
    guard methods.contains(0) else { throw TunnelError.protocolViolation }
    try await send(Data([5, 0]), to: connection)
    let request = try await read(connection, count: 4)
    // Domain-only CONNECT keeps DNS resolution out of the direct network path.
    guard request == Data([5, 1, 0, 3]) else { throw TunnelError.protocolViolation }
    let length = try await read(connection, count: 1)
    let hostname = try await read(connection, count: Int(length[0]))
    let port = try await read(connection, count: 2)
    guard let name = String(data: hostname, encoding: .utf8),
      ["core.test", "wrong.test"].contains(name), port == Data([1, 187])
    else { throw TunnelError.protocolViolation }
    let socket = outer.webSocketTask(with: endpoint)
    socket.maximumMessageSize = 64 * 1024
    socket.resume()
    defer { socket.cancel(with: .goingAway, reason: nil) }
    try await send(Data([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), to: connection)
    try await withThrowingTaskGroup(of: Void.self) { group in
      group.addTask {
        while !Task.isCancelled {
          let bytes = try await self.receive(connection, maximum: 16 * 1024)
          guard !bytes.isEmpty else { return }
          try await socket.send(.data(bytes))
        }
      }
      group.addTask {
        while !Task.isCancelled {
          guard case .data(let bytes) = try await socket.receive(), bytes.count <= 64 * 1024
          else { throw TunnelError.protocolViolation }
          try await self.send(bytes, to: connection)
        }
      }
      defer {
        group.cancelAll()
        connection.cancel()
        socket.cancel(with: .goingAway, reason: nil)
      }
      _ = try await group.next()
    }
  }
}
