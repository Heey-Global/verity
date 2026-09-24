import Foundation
import Network
#if canImport(UIKit)
import UIKit
#endif

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
