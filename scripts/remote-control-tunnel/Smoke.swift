import Foundation
import Network
#if canImport(UIKit)
import UIKit
#endif

enum ProductionProbeFailure: Error { case transport(String) }

// The prototype uses a different SOCKS implementation; only this
// path can catch regressions in the shipping app's stream forwarding.
@available(macOS 14.0, iOS 17.0, *)
func runProductionTunnelSmoke(endpoint: URL, outerPin: String, corePin: String) async throws {
  let dataURL = endpoint.deletingLastPathComponent().appendingPathComponent("data")
  for (host, pin, expectedFailure, connect) in [
    // A second attachment must work after the preceding tunnel is torn down.
    ("core.test", corePin, "", false),
    ("core.test", corePin, "", false),
    // The app falls back to HTTP CONNECT when SOCKS fails the Core probe on a
    // device; the same listener must carry both dialects.
    ("core.test", corePin, "", true),
    ("core.test", "sha256-" + String(repeating: "A", count: 43), "PIN_MISMATCH", false),
    ("wrong.test", corePin, "PINNED_CHAIN_TRUST_FAILED", true),
  ] {
    let origin = URL(string: "https://\(host)")!
    var outerOrigin = URLComponents(url: dataURL, resolvingAgainstBaseURL: false)!
    outerOrigin.scheme = "https"
    let outerDelegate = try CertificatePinDelegate(pin: outerPin, origin: outerOrigin.url!)
    let outer = URLSession(configuration: .ephemeral, delegate: outerDelegate, delegateQueue: nil)
    let tunnel = try RemoteAppTunnel(dataURL: dataURL, coreURL: origin, outerSession: outer)
    defer { tunnel.stop(); outer.invalidateAndCancel() }
    let port = try await tunnel.start(ticket: "fixture-ticket", sessionId: "fixture-session")
    if connect {
      // Any local process can dial the listener; only the host and port check
      // keeps the tunnel pinned to the paired Core.
      let otherHost = host == "core.test" ? "wrong.test" : "core.test"
      for head in [
        "CONNECT \(otherHost):443 HTTP/1.1\r\n\r\n",
        "CONNECT \(host):8443 HTTP/1.1\r\n\r\n",
        "CONNECT \(host) HTTP/1.1\r\n\r\n",
        "GET / HTTP/1.1\r\nHost: \(host)\r\n\r\n",
        "CONNECT \(host):443\r\n\r\n",
      ] {
        try await expectConnectRejected(port: port, head: head)
      }
    }
    let loopback = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!)
    let proxy = connect
      ? ProxyConfiguration(httpCONNECTProxy: loopback)
      : ProxyConfiguration(socksv5Proxy: loopback)
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 10
    config.timeoutIntervalForResource = 15
    config.proxyConfigurations = [proxy]
    let delegate = try CertificatePinDelegate(pin: pin, origin: origin)
    let client = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    defer { client.invalidateAndCancel() }
    do {
      let (body, response) = try await client.data(for: URLRequest(url: origin.appendingPathComponent("healthz")))
      guard expectedFailure.isEmpty,
        (response as? HTTPURLResponse)?.statusCode == 200,
        String(data: body, encoding: .utf8) == "core-ok",
        delegate.phase == "PIN_AND_CHAIN_TRUST_ACCEPTED"
      else { throw TunnelError.protocolViolation }
      var request = URLRequest(url: origin.appendingPathComponent("echo"))
      request.httpMethod = "POST"
      request.httpBody = Data(repeating: 0x61, count: 96 * 1024)
      let (echo, echoResponse) = try await client.data(for: request)
      guard echo == request.httpBody, (echoResponse as? HTTPURLResponse)?.statusCode == 200
      else { throw TunnelError.protocolViolation }
      let socket = client.webSocketTask(with: URL(string: "wss://\(host)/socket")!)
      defer { socket.cancel(with: .normalClosure, reason: nil) }
      socket.resume()
      try await socket.send(.string("production-tunnel-echo"))
      guard case .string("production-tunnel-echo") = try await socket.receive()
      else { throw TunnelError.protocolViolation }
      // A reused session hides failures caused by the app's fresh TLS connection
      // per request. Keep a WebSocket alive while those connections churn.
      for batch in 0..<3 {
        try await withThrowingTaskGroup(of: Void.self) { group in
          for _ in 0..<4 {
            group.addTask {
              let requestConfig = URLSessionConfiguration.ephemeral
              requestConfig.timeoutIntervalForRequest = 10
              requestConfig.timeoutIntervalForResource = 15
              requestConfig.proxyConfigurations = [proxy]
              let requestDelegate = try CertificatePinDelegate(pin: pin, origin: origin)
              let requestClient = URLSession(configuration: requestConfig,
                delegate: requestDelegate, delegateQueue: nil)
              defer { requestClient.finishTasksAndInvalidate() }
              let body: Data
              let response: URLResponse
              do {
                (body, response) = try await requestClient.data(
                  for: URLRequest(url: origin.appendingPathComponent("healthz")))
              } catch {
                throw ProductionProbeFailure.transport(
                  CertificatePinDelegate.transportFailure(
                    error: error as NSError, phase: requestDelegate.phase))
              }
              guard (response as? HTTPURLResponse)?.statusCode == 200,
                String(data: body, encoding: .utf8) == "core-ok",
                requestDelegate.phase == "PIN_AND_CHAIN_TRUST_ACCEPTED"
              else { throw TunnelError.protocolViolation }
            }
          }
          try await group.waitForAll()
        }
        let message = "production-churn-\(batch)"
        try await socket.send(.string(message))
        guard case .string(let echoed) = try await socket.receive(), echoed == message
        else { throw TunnelError.protocolViolation }
      }
    } catch {
      if let failure = error as? ProductionProbeFailure { throw failure }
      guard !expectedFailure.isEmpty, delegate.failure?.hasPrefix(expectedFailure) == true else {
        throw ProductionProbeFailure.transport(
          CertificatePinDelegate.transportFailure(error: error as NSError, phase: delegate.phase))
      }
    }
    let summary = tunnel.diagnosticSummary
    guard summary.contains(", streams=s1=up"), summary.contains(connect ? ".pconnect." : ".psocks."),
      summary.contains(".o22"), summary.contains(".i22")
    else { throw ProductionProbeFailure.transport("stream trace missing: \(summary)") }
    print("production app case passed: \(expectedFailure.isEmpty ? "valid-private-ca" : expectedFailure) via \(connect ? "connect" : "socks")")
  }
}

// A rejected CONNECT is closed without a reply; a 200 or a hang is a failure.
@available(macOS 14.0, iOS 17.0, *)
func expectConnectRejected(port: Int, head: String) async throws {
  let connection = NWConnection(
    host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!, using: .tcp)
  connection.start(queue: .global())
  defer { connection.cancel() }
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    connection.send(content: Data(head.utf8), completion: .contentProcessed { error in
      if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    })
  }
  let reply: String = await withCheckedContinuation { continuation in
    let lock = NSLock()
    var finished = false
    let finish: (String) -> Void = { value in
      lock.lock()
      defer { lock.unlock() }
      guard !finished else { return }
      finished = true
      continuation.resume(returning: value)
    }
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64) { data, _, _, _ in
      finish(data.map { String(decoding: $0, as: UTF8.self) } ?? "")
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 5) { finish("timeout") }
  }
  guard reply != "timeout", !reply.hasPrefix("HTTP/1.1 200") else {
    throw ProductionProbeFailure.transport("CONNECT not rejected: \(head.prefix(24))")
  }
}

func checkFailureDiagnostics() throws {
  let underlying = NSError(domain: NSOSStatusErrorDomain, code: -9802)
  let error = NSError(domain: NSURLErrorDomain, code: -1200, userInfo: [
    NSUnderlyingErrorKey: underlying,
    "_kCFStreamErrorDomainKey": 3,
    "_kCFStreamErrorCodeKey": -9802,
    NSLocalizedDescriptionKey: "secret-body",
  ])
  let result = CertificatePinDelegate.transportFailure(error: error, phase: "NO_AUTH_CHALLENGE")
  guard result.contains("NSURLErrorDomain:-1200:NO_AUTH_CHALLENGE"),
    result.contains("streamDomain:3:streamCode:-9802"),
    result.contains("underlying:NSOSStatusErrorDomain:-9802"), !result.contains("secret-body")
  else { throw TunnelError.protocolViolation }
  var nested = NSError(domain: "secret-domain", code: 10, userInfo: [NSLocalizedDescriptionKey: "secret-message"])
  for index in 0..<10 { nested = NSError(domain: "secret-domain", code: index, userInfo: [NSUnderlyingErrorKey: nested]) }
  let bounded = CertificatePinDelegate.transportFailure(error: nested, phase: "secret-phase")
  guard bounded.contains("OtherErrorDomain"), bounded.contains("UNKNOWN_PHASE"),
    !bounded.contains("secret"), bounded.components(separatedBy: "underlying:").count <= 3
  else { throw TunnelError.protocolViolation }
}

@available(macOS 14.0, iOS 17.0, *)
func runTunnelSmoke(endpoint: URL, outerPin: String, corePin: String) async throws {
  func session(port: NWEndpoint.Port, host: String = "core.test", pin: String) throws
    -> (URLSession, CertificatePinDelegate)
  {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 10
    config.timeoutIntervalForResource = 20
    config.proxyConfigurations = [ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: port))]
    let delegate = try CertificatePinDelegate(pin: pin, origin: URL(string: "https://\(host)")!)
    return (URLSession(configuration: config, delegate: delegate, delegateQueue: nil), delegate)
  }
  let tunnel = try NativeTunnel(endpoint: endpoint, pin: outerPin)
  let port = try await tunnel.start()
  do {
    let (client, _) = try session(port: port, pin: corePin)
    defer { client.invalidateAndCancel() }
    let (body, response) = try await client.data(from: URL(string: "https://core.test/")!)
    guard (response as? HTTPURLResponse)?.statusCode == 200, String(data: body, encoding: .utf8) == "core-ok"
    else { throw TunnelError.protocolViolation }
    var request = URLRequest(url: URL(string: "https://core.test/echo")!)
    request.httpMethod = "POST"
    request.httpBody = Data(repeating: 0x61, count: 32 * 1024)
    let (echo, echoResponse) = try await client.data(for: request)
    guard echo == request.httpBody, (echoResponse as? HTTPURLResponse)?.statusCode == 200
    else { throw TunnelError.protocolViolation }
    let socket = client.webSocketTask(with: URL(string: "wss://core.test/socket")!)
    socket.maximumMessageSize = 16 * 1024
    socket.resume()
    try await socket.send(.string("tunnel-echo"))
    guard case .string("tunnel-echo") = try await socket.receive()
    else { throw TunnelError.protocolViolation }
    socket.cancel(with: .normalClosure, reason: nil)

    for (host, pin, reason) in [
      ("core.test", "sha256-" + String(repeating: "A", count: 43), "PIN_MISMATCH"),
      ("wrong.test", corePin, "PINNED_CHAIN_TRUST_FAILED"),
    ] {
      let (negative, delegate) = try session(port: port, host: host, pin: pin)
      defer { negative.invalidateAndCancel() }
      var rejected = false
      do { _ = try await negative.data(from: URL(string: "https://\(host)/")!) }
      catch { rejected = true }
      guard rejected, delegate.failure?.hasPrefix(reason) == true
      else { throw TunnelError.protocolViolation }
    }
    // Stopping a live tunnel must release a pending native WebSocket receive.
    let pendingSocket = client.webSocketTask(with: URL(string: "wss://core.test/socket")!)
    pendingSocket.resume()
    try await pendingSocket.send(.string("ready"))
    _ = try await pendingSocket.receive()
    let pending = Task { try await pendingSocket.receive() }
    await tunnel.stop()
    var stopped = false
    do { _ = try await pending.value } catch { stopped = true }
    guard stopped else { throw TunnelError.protocolViolation }
  } catch {
    await tunnel.stop()
    throw error
  }

  let restarted = try NativeTunnel(endpoint: endpoint, pin: outerPin)
  let restartedPort = try await restarted.start()
  do {
    let (client, _) = try session(port: restartedPort, pin: corePin)
    defer { client.invalidateAndCancel() }
    let (_, response) = try await client.data(from: URL(string: "https://core.test/")!)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw TunnelError.protocolViolation }
    await restarted.stop()
  } catch {
    await restarted.stop()
    throw error
  }

  let badOuter = try NativeTunnel(endpoint: endpoint,
    pin: "sha256-" + String(repeating: "A", count: 43))
  let badPort = try await badOuter.start()
  let (rejectedClient, _) = try session(port: badPort, pin: corePin)
  var outerRejected = false
  do { _ = try await rejectedClient.data(from: URL(string: "https://core.test/")!) }
  catch { outerRejected = true }
  rejectedClient.invalidateAndCancel()
  await badOuter.stop()
  guard outerRejected, badOuter.outerFailure == "PIN_MISMATCH"
  else { throw TunnelError.protocolViolation }
}

@available(macOS 14.0, iOS 17.0, *)
func smokeResult() async -> String {
  let environment = ProcessInfo.processInfo.environment
  let watchdog = Task {
    try? await Task.sleep(nanoseconds: 90_000_000_000)
    guard !Task.isCancelled else { return }
    let failure = "FAIL: native tunnel watchdog expired"
    if let path = environment["VERITY_TUNNEL_RESULT"] {
      try? failure.write(toFile: path, atomically: true, encoding: .utf8)
    }
    print(failure)
    exit(1)
  }
  defer { watchdog.cancel() }
  let arguments = CommandLine.arguments
  let endpoint = environment["VERITY_TUNNEL_URL"] ?? (arguments.count > 1 ? arguments[1] : "")
  let outerPin = environment["VERITY_TUNNEL_OUTER_PIN"] ?? (arguments.count > 2 ? arguments[2] : "")
  let corePin = environment["VERITY_TUNNEL_CORE_PIN"] ?? (arguments.count > 3 ? arguments[3] : "")
  guard let url = URL(string: endpoint), url.scheme == "wss" else { return "FAIL: missing WSS endpoint" }
  do {
    try checkFailureDiagnostics()
    try await runProductionTunnelSmoke(endpoint: url, outerPin: outerPin, corePin: corePin)
    try await runTunnelSmoke(endpoint: url, outerPin: outerPin, corePin: corePin)
    return "success"
  } catch { return "FAIL: \(error)" }
}

#if canImport(UIKit)
@main
@available(iOS 17.0, *)
final class TunnelSmokeApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool
  {
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = UIViewController()
    window.makeKeyAndVisible()
    self.window = window
    Task {
      let result = await smokeResult()
      print(result)
      if let path = ProcessInfo.processInfo.environment["VERITY_TUNNEL_RESULT"] {
        try? result.write(toFile: path, atomically: true, encoding: .utf8)
      }
    }
    return true
  }
}
#else
@main
@available(macOS 14.0, *)
struct TunnelSmoke {
  static func main() async {
    let result = await smokeResult()
    print(result)
    if result != "success" { exit(1) }
  }
}
#endif
