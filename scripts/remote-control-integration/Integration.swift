import Foundation
import CryptoKit
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
  let scenario: String
  let controlURL: URL
  let largeHash: String
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

private final class IntegrationDispatch: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  func mark() { lock.withLock { value = true } }
  var started: Bool { lock.withLock { value } }
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
    defer { healthClient.invalidateAndCancel() }
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

    var pooledChecks: [String] = []
    if ["pooled", "frame-release", "frame-abort"].contains(manifest.scenario) {
      progress.update("pooled_requests")
      let pool = PinnedHTTPSessionPool()
      defer { pool.shutdown() }
      func pooledRequest(_ path: String, lane: PinnedHTTPTransportLane, dispatch: IntegrationDispatch? = nil) async throws -> Data {
        let lease = try pool.acquire(origin: coreOrigin, pin: manifest.corePin,
          proxyPort: port, proxyMode: "socks", lane: lane)
        defer { lease.release() }
        let delegate = try CertificatePinDelegate(pin: manifest.corePin, origin: coreOrigin)
        var request = URLRequest(url: coreOrigin.appendingPathComponent(path))
        request.timeoutInterval = 20
        if path == "send" { request.httpMethod = "POST"; request.httpBody = Data("synthetic-turn".utf8) }
        return try await withCheckedThrowingContinuation { continuation in
          let task = lease.session.dataTask(with: request) { data, response, error in
            if let error { continuation.resume(throwing: error) }
            else if let data, (response as? HTTPURLResponse)?.statusCode == 200 {
              continuation.resume(returning: data)
            } else { continuation.resume(throwing: IntegrationFailure.receipt) }
          }
          task.delegate = delegate
          task.resume()
          dispatch?.mark()
        }
      }
      // Both lane pools are warm before the fault; all workload requests use
      // the tunnel. Only the fixture-control channel bypasses it.
      _ = try await pooledRequest("healthz", lane: .interactive)
      _ = try await pooledRequest("healthz", lane: .background)
      let controlDelegate = try CertificatePinDelegate(pin: manifest.corePin, origin: manifest.controlURL)
      let control = URLSession(configuration: .ephemeral, delegate: controlDelegate, delegateQueue: nil)
      defer { control.invalidateAndCancel() }
      func command(_ path: String) async throws -> Data {
        var request = URLRequest(url: manifest.controlURL.appendingPathComponent(path))
        request.timeoutInterval = 3
        let (data, response) = try await control.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw IntegrationFailure.receipt }
        return data
      }
      let large = Task { try await pooledRequest("large", lane: .interactive) }
      defer { large.cancel() }
      if manifest.scenario != "pooled" {
        var held = false
        for _ in 0..<100 {
          let status = try JSONSerialization.jsonObject(with: await command("control")) as? [String: Any]
          if status?["held"] as? Bool == true { held = true; break }
          try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard held else { throw IntegrationFailure.receipt }
      }
      let dispatch = IntegrationDispatch()
      let small = Task { try await pooledRequest("small", lane: .background, dispatch: dispatch) }
      defer { small.cancel() }
      let sendDispatch = IntegrationDispatch()
      let send = Task { try await pooledRequest("send", lane: .interactive, dispatch: sendDispatch) }
      defer { send.cancel() }
      if manifest.scenario != "pooled" {
        for _ in 0..<100 {
          if dispatch.started && sendDispatch.started { break }
          try await Task.sleep(nanoseconds: 10_000_000)
        }
        guard dispatch.started && sendDispatch.started else { throw IntegrationFailure.receipt }
        _ = try await command("release")
      }
      if manifest.scenario == "frame-abort" {
        var largeFailed = false
        do { _ = try await large.value } catch { largeFailed = true }
        _ = try? await small.value
        _ = try? await send.value
        guard largeFailed else { throw IntegrationFailure.receipt }
        tunnel.stop()
        let result = try JSONSerialization.data(withJSONObject: ["success": true,
          "scenario": manifest.scenario, "checks": ["pooled_frame_abort", "bounded_large_failure"]])
        persistIntegrationResult(String(decoding: result, as: UTF8.self))
        return true
      }
      let body = try await large.value
      guard body.count == 8 * 1024 * 1024,
        SHA256.hash(data: body).map({ String(format: "%02x", $0) }).joined() == manifest.largeHash,
        try await small.value == Data("small-ok".utf8),
        try await pooledRequest("small", lane: .background) == Data("small-ok".utf8),
        try await send.value == Data("sent-ok".utf8)
      else { throw IntegrationFailure.receipt }
      pooledChecks = ["pooled_large_digest", "pooled_small_receipt", "pooled_reuse_receipt", "pooled_send_receipt"]
      if manifest.scenario == "frame-release" { pooledChecks.append("held_frame_released") }
    }

    if manifest.scenario == "loss" {
      progress.update("directional_loss")
      func pongCount() -> Int {
        let summary = tunnel.diagnosticSummary
        guard let field = summary.components(separatedBy: ", ").first(where: { $0.hasPrefix("pings=") }),
          let count = field.split(separator: "/").last, let value = Int(count)
        else { return -1 }
        return value
      }
      let before = pongCount()
      guard before >= 0 else { throw IntegrationFailure.diagnostics }
      // Reuse the established TLS connection: suppressing its reply must not merely test TLS setup.
      var request = URLRequest(url: coreOrigin.appendingPathComponent("fault"))
      request.httpMethod = "POST"
      request.httpBody = Data("native-reverse-receipt".utf8)
      request.timeoutInterval = 22
      var timedOut = false
      do { _ = try await healthClient.data(for: request) }
      catch {
        let failure = error as NSError
        timedOut = failure.domain == NSURLErrorDomain && failure.code == NSURLErrorTimedOut
      }
      guard timedOut, tunnel.isActive, pongCount() > before else { throw IntegrationFailure.receipt }
    }

    progress.update("shutdown")
    tunnel.stop()
    tunnel.stop()
    guard let export = tunnel.exportDataDiagnostics(),
      let snapshot = try JSONSerialization.jsonObject(with: Data(export.utf8)) as? [String: Any],
      let events = snapshot["events"] as? [[String: Any]]
    else { throw IntegrationFailure.diagnostics }
    let names = events.map { $0["event"] as? String ?? "unknown" }
    guard names.contains("attached"),
      names.filter({ $0 == "cancel_requested" }).count == 1,
      names.filter({ $0 == "socket_cancel" }).count == 1,
      let requested = names.firstIndex(of: "cancel_requested"),
      let cancelled = names.firstIndex(of: "socket_cancel"), requested < cancelled,
      events[requested]["cause"] as? String == "app_stop",
      events[cancelled]["cause"] as? String == "app_stop",
      !events.prefix(requested).contains(where: { $0["event"] as? String == "failure" })
    else { throw IntegrationFailure.diagnostics }
    var checks = ["production_decoder", "app_attached", "health_receipt", "parallel_exact_echo",
      "core_pin_rejection", "ordered_idempotent_stop"]
    checks += pooledChecks
    if manifest.scenario == "loss" { checks += ["bounded_missing_response", "native_pong_during_loss"] }
    if manifest.scenario == "recovery" { checks += ["fresh_pair_exact_receipts"] }
    let result = try JSONSerialization.data(withJSONObject:
      ["success": true, "scenario": manifest.scenario, "checks": checks], options: [.sortedKeys])
    persistIntegrationResult(String(decoding: result, as: UTF8.self))
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
