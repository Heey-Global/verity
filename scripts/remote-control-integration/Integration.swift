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

// The watchdog needs progress even when an awaited native operation never returns.
private final class IntegrationProgress: @unchecked Sendable {
  private let lock = NSLock()
  private var currentStage = "decoder"
  private var delegate: CertificatePinDelegate?

  func update(_ stage: String) { lock.withLock { currentStage = stage } }
  func bind(_ value: CertificatePinDelegate) { lock.withLock { delegate = value } }
  func result(_ error: String) -> [String: Any] {
    let (stage, outer) = lock.withLock { (currentStage, delegate) }
    let known: Set<String> = ["CERTIFICATE_KEY_UNAVAILABLE", "PIN_MISMATCH",
      "UNSUPPORTED_KEY_FORMAT", "CERTIFICATE_CHAIN_UNAVAILABLE"]
    let failure = outer?.failure ?? "NONE"
    let rejection = known.contains(failure) ? failure
      : (failure.hasPrefix("PINNED_CHAIN_TRUST_FAILED:") ? "PINNED_CHAIN_TRUST_FAILED" : "NONE")
    var value: [String: Any] = ["success": false, "error": error, "stage": stage,
      "outerTLSPhase": outer?.phase ?? "NO_AUTH_CHALLENGE", "outerTLSRejection": rejection]
    if let code = outer?.trustErrorCode { value["outerTrustErrorCode"] = code }
    return value
  }
}

private func persistIntegrationFailure(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
    let json = String(data: data, encoding: .utf8) { persistIntegrationResult(json) }
}

@available(macOS 14.0, iOS 17.0, *)
private func runIntegration() async -> Bool {
  let progress = IntegrationProgress()
  let watchdog = Task {
    try? await Task.sleep(nanoseconds: 90_000_000_000)
    guard !Task.isCancelled else { return }
    persistIntegrationFailure(progress.result("watchdog"))
    exit(1)
  }
  defer { watchdog.cancel() }
  var outerDiagnostics: CertificatePinDelegate?
  do {
    try runNativeProtocolChecks()
    progress.update("manifest")
    guard let manifestPath = ProcessInfo.processInfo.environment["VERITY_INTEGRATION_MANIFEST"]
    else { throw IntegrationFailure.invalidManifest }
    if let readyPath = ProcessInfo.processInfo.environment["VERITY_INTEGRATION_READY"] {
      try "ready".write(toFile: readyPath, atomically: true, encoding: .utf8)
      // Simulator launch latency must not consume the fixture's admission lifetime.
      for _ in 0..<300 {
        if FileManager.default.fileExists(atPath: manifestPath) { break }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
    }
    let manifest = try JSONDecoder().decode(IntegrationManifest.self,
      from: Data(contentsOf: URL(fileURLWithPath: manifestPath)))
    guard manifest.dataURL.host == "127.0.0.1", manifest.dataURL.scheme == "wss"
    else { throw IntegrationFailure.invalidManifest }
    let coreOrigin = URL(string: "https://core.test")!
    var outerOrigin = URLComponents(url: manifest.dataURL, resolvingAgainstBaseURL: false)!
    outerOrigin.scheme = "https"
    let outerDelegate = try CertificatePinDelegate(pin: manifest.outerPin, origin: outerOrigin.url!)
    outerDiagnostics = outerDelegate
    progress.bind(outerDelegate)
    let outer = URLSession(configuration: .ephemeral, delegate: outerDelegate, delegateQueue: nil)
    defer { outer.invalidateAndCancel() }
    let tunnel = try RemoteAppTunnel(dataURL: manifest.dataURL, coreURL: coreOrigin, outerSession: outer)
    tunnel.enableDataDiagnostics()
    defer { tunnel.stop() }
    progress.update("attachment")
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

    progress.update("health")
    let (healthClient, _) = try client(pin: manifest.corePin)
    let (health, healthResponse) = try await healthClient.data(from: coreOrigin.appendingPathComponent("healthz"))
    healthClient.invalidateAndCancel()
    guard health == Data("core-ok".utf8), (healthResponse as? HTTPURLResponse)?.statusCode == 200
    else { throw IntegrationFailure.receipt }

    // Separate sessions exercise parallel production streams. HTTP body completion is not a stream half-close assertion.
    progress.update("echo")
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

    progress.update("pin_rejection")
    let (wrongPinClient, wrongPinDelegate) = try client(pin: "sha256-" + String(repeating: "A", count: 43))
    defer { wrongPinClient.invalidateAndCancel() }
    var rejected = false
    do { _ = try await wrongPinClient.data(from: coreOrigin.appendingPathComponent("healthz")) }
    catch { rejected = true }
    guard rejected, wrongPinDelegate.failure == "PIN_MISMATCH" else { throw IntegrationFailure.pin }

    progress.update("shutdown")
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
    var result = progress.result("native_integration_failed")
    result["transport"] = CertificatePinDelegate.transportFailure(error: error as NSError,
      phase: outerDiagnostics?.phase ?? "NO_AUTH_CHALLENGE")
    persistIntegrationFailure(result)
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
