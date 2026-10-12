import Foundation
import Network
#if canImport(UIKit)
import UIKit
#endif

private struct IntegrationManifest: Decodable {
  let dataURL: URL
  let appTicket: String
  let sessionId: String
  let outerPin: String
  let corePin: String
}

private enum IntegrationFailure: Error { case invalidManifest, receipt, pin, diagnostics }

private func persistIntegrationResult(_ result: String) {
  print(result)
  if let path = ProcessInfo.processInfo.environment["VERITY_INTEGRATION_RESULT"] {
    try? result.write(toFile: path, atomically: true, encoding: .utf8)
  }
}

@available(macOS 14.0, iOS 17.0, *)
private func runIntegration() async -> Bool {
  let watchdog = Task {
    try? await Task.sleep(nanoseconds: 90_000_000_000)
    guard !Task.isCancelled else { return }
    persistIntegrationResult("{\"success\":false,\"error\":\"watchdog\"}")
    exit(1)
  }
  defer { watchdog.cancel() }
  var stage = "decoder"
  var outerDiagnostics: CertificatePinDelegate?
  do {
    try runNativeProtocolChecks()
    stage = "manifest"
    guard let manifestPath = ProcessInfo.processInfo.environment["VERITY_INTEGRATION_MANIFEST"]
    else { throw IntegrationFailure.invalidManifest }
    let manifest = try JSONDecoder().decode(IntegrationManifest.self,
      from: Data(contentsOf: URL(fileURLWithPath: manifestPath)))
    guard manifest.dataURL.host == "127.0.0.1", manifest.dataURL.scheme == "wss"
    else { throw IntegrationFailure.invalidManifest }
    let coreOrigin = URL(string: "https://core.test")!
    var outerOrigin = URLComponents(url: manifest.dataURL, resolvingAgainstBaseURL: false)!
    outerOrigin.scheme = "https"
    let outerDelegate = try CertificatePinDelegate(pin: manifest.outerPin, origin: outerOrigin.url!)
    outerDiagnostics = outerDelegate
    let outer = URLSession(configuration: .ephemeral, delegate: outerDelegate, delegateQueue: nil)
    defer { outer.invalidateAndCancel() }
    let tunnel = try RemoteAppTunnel(dataURL: manifest.dataURL, coreURL: coreOrigin, outerSession: outer)
    tunnel.enableDataDiagnostics()
    defer { tunnel.stop() }
    stage = "attachment"
    let port = try await tunnel.start(ticket: manifest.appTicket, sessionId: manifest.sessionId)
    guard let proxyPort = NWEndpoint.Port(rawValue: UInt16(port)) else { throw IntegrationFailure.receipt }

    func client(pin: String) throws -> (URLSession, CertificatePinDelegate) {
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForRequest = 15
      config.timeoutIntervalForResource = 30
      config.proxyConfigurations = [ProxyConfiguration(socksv5Proxy:
        .hostPort(host: "127.0.0.1", port: proxyPort))]
      let delegate = try CertificatePinDelegate(pin: pin, origin: coreOrigin)
      return (URLSession(configuration: config, delegate: delegate, delegateQueue: nil), delegate)
    }

    stage = "health"
    let (healthClient, _) = try client(pin: manifest.corePin)
    let (health, healthResponse) = try await healthClient.data(from: coreOrigin.appendingPathComponent("healthz"))
    healthClient.invalidateAndCancel()
    guard health == Data("core-ok".utf8), (healthResponse as? HTTPURLResponse)?.statusCode == 200
    else { throw IntegrationFailure.receipt }

    // Separate sessions exercise parallel production streams. HTTP body completion is not a stream half-close assertion.
    stage = "echo"
    try await withThrowingTaskGroup(of: Void.self) { group in
      for size in [0, 1, 8192, 65536] {
        let (session, _) = try client(pin: manifest.corePin)
        group.addTask {
          defer { session.invalidateAndCancel() }
          let payload = Data((0..<size).map { UInt8(($0 * 31 + size) % 251) })
          var request = URLRequest(url: coreOrigin.appendingPathComponent("echo"))
          request.httpMethod = "POST"
          request.httpBody = payload
          let (received, response) = try await session.data(for: request)
          guard received == payload, (response as? HTTPURLResponse)?.statusCode == 200
          else { throw IntegrationFailure.receipt }
        }
      }
      try await group.waitForAll()
    }

    stage = "pin_rejection"
    let (wrongPinClient, wrongPinDelegate) = try client(pin: "sha256-" + String(repeating: "A", count: 43))
    defer { wrongPinClient.invalidateAndCancel() }
    var rejected = false
    do { _ = try await wrongPinClient.data(from: coreOrigin.appendingPathComponent("healthz")) }
    catch { rejected = true }
    guard rejected, wrongPinDelegate.failure == "PIN_MISMATCH" else { throw IntegrationFailure.pin }

    stage = "shutdown"
    tunnel.stop()
    tunnel.stop()
    guard let export = tunnel.exportDataDiagnostics(),
      let snapshot = try JSONSerialization.jsonObject(with: Data(export.utf8)) as? [String: Any],
      let events = snapshot["events"] as? [[String: Any]]
    else { throw IntegrationFailure.diagnostics }
    let names = events.compactMap { $0["event"] as? String }
    guard names.contains("attached"),
      names.filter({ $0 == "cancel_requested" }).count == 1,
      names.filter({ $0 == "socket_cancel" }).count == 1,
      let requested = names.firstIndex(of: "cancel_requested"),
      let cancelled = names.firstIndex(of: "socket_cancel"), requested < cancelled
    else { throw IntegrationFailure.diagnostics }
    persistIntegrationResult("{\"success\":true,\"checks\":[\"production_decoder\",\"app_attached\",\"health_receipt\",\"parallel_exact_echo\",\"core_pin_rejection\",\"ordered_idempotent_stop\"]}")
    return true
  } catch {
    // Reuse the production allowlist; never serialize NSError descriptions or userInfo.
    let result: [String: Any] = [
      "success": false, "error": "native_integration_failed", "stage": stage,
      "transport": CertificatePinDelegate.transportFailure(error: error as NSError,
        phase: outerDiagnostics?.phase ?? "NO_AUTH_CHALLENGE"),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
      let json = String(data: data, encoding: .utf8) { persistIntegrationResult(json) }
    return false
  }
}

#if canImport(UIKit)
final class IntegrationSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: windowScene)
    window.rootViewController = UIViewController()
    self.window = window
    window.makeKeyAndVisible()
  }
}

@main
@available(iOS 17.0, *)
final class IntegrationApp: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    Task { _ = await runIntegration() }
    return true
  }
}
#else
@main
@available(macOS 14.0, *)
struct IntegrationApp {
  static func main() async {
    if !(await runIntegration()) { exit(1) }
  }
}
#endif
