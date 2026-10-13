import Foundation
import Network

func checkStallRecorder() {
  let recorder = StallDiagnostics()
  let start = StallDiagnostics.now()
  recorder.opened("a", port: 1001)
  let first = recorder.enqueue("a")
  recorder.started(first)
  let later = recorder.enqueue("a")
  let pending = recorder.snapshot(ports: [1001], since: start)
  precondition(pending["mapping"] as? String == "matched")
  precondition(pending["sending"] as? Int == 1 && pending["queued"] as? Int == 1)
  recorder.finished(first, failed: false)
  recorder.started(later)
  recorder.finished(later, failed: true)
  let ended = recorder.snapshot(ports: [1001], since: start)
  precondition(ended["completed"] as? Int == 1 && ended["failed"] as? Int == 1)
  precondition(recorder.snapshot(ports: [], since: start)["mapping"] as? String == "unknown")
  recorder.opened("reused", port: 1001)
  precondition(recorder.snapshot(ports: [1001], since: start)["mapping"] as? String == "ambiguous")
  precondition(recorder.snapshot(ports: [1001, 1002], since: start)["mapping"] as? String == "ambiguous")
  for index in 0..<StallDiagnostics.streamLimit { recorder.opened("\(index)", port: 1002) }
  precondition(recorder.snapshot(ports: [1001], since: start)["mapping"] as? String == "overflow")
  let bounded = StallDiagnostics()
  for _ in 0...StallDiagnostics.sendLimit { _ = bounded.enqueue("private-wire-id") }
  let overflow = bounded.snapshot(ports: [], since: StallDiagnostics.now())
  precondition(overflow["overflow"] as? Bool == true)
  precondition(overflow["globalQueued"] as? Int == StallDiagnostics.sendLimit)
  let text = String(data: try! JSONSerialization.data(withJSONObject: overflow), encoding: .utf8)!
  precondition(!text.contains("private-wire-id"))
}

@available(macOS 14.0, iOS 17.0, *)
func checkStallObservation(proxy: ProxyConfiguration, origin: URL, pin: String,
  recorder: StallDiagnostics) async throws {
  checkStallRecorder()
  let redirectPin = try CertificatePinDelegate(pin: pin, origin: origin)
  let redirectObserver = StallHTTPObserver(pin: redirectPin, recorder: recorder)
  let redirectSession = URLSession(configuration: .ephemeral)
  defer { redirectSession.invalidateAndCancel() }
  let redirectTask = redirectSession.dataTask(with: origin)
  let response = HTTPURLResponse(url: origin, statusCode: 302, httpVersion: nil, headerFields: nil)!
  for (target, allowed) in [(origin.appendingPathComponent("healthz"), true),
    (URL(string: "http://core.test/")!, false), (URL(string: "https://other.test/")!, false),
    (URL(string: "https://core.test:444/")!, false), (URL(string: "https://user@core.test/")!, false)] {
    var called = false
    redirectObserver.urlSession(redirectSession, task: redirectTask,
      willPerformHTTPRedirection: response, newRequest: URLRequest(url: target)) { request in
      called = true
      precondition((request != nil) == allowed)
    }
    precondition(called)
  }
  // Each observer owns a fresh session, matching the soak's request lifecycle.
  func request(_ path: String) async throws -> [String: Any] {
    let config = URLSessionConfiguration.ephemeral
    config.proxyConfigurations = [proxy]
    config.timeoutIntervalForRequest = 2
    config.timeoutIntervalForResource = 2
    let delegate = try CertificatePinDelegate(pin: pin, origin: origin)
    let observer = StallHTTPObserver(pin: delegate, recorder: recorder)
    let session = URLSession(configuration: config, delegate: observer, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    do {
      let response = try await observer.request(origin.appendingPathComponent(path), session: session)
      precondition(path == "healthz" && (response as? HTTPURLResponse)?.statusCode == 200)
    } catch {
      precondition(path != "healthz" && (error as NSError).code == NSURLErrorTimedOut)
    }
    let snapshot = observer.snapshot
    let writer = snapshot["writer"] as! [String: Any]
    // If the platform does not expose usable proxy endpoints, do not silently
    // bless a diagnostic that cannot attribute the failing request.
    precondition(writer["mapping"] as? String == "matched", "missing native request/stream mapping")
    precondition((writer["completed"] as? Int ?? 0) > 0)
    precondition(writer["queued"] as? Int == 0 && writer["sending"] as? Int == 0)
    precondition((snapshot["headersMs"] as? Int == -1) == (path == "slow"))
    precondition((snapshot["firstByteMs"] as? Int == -1) == (path == "slow"))
    // A duplicate completion or late data callback must not rewrite evidence.
    let before = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
    let unused = session.dataTask(with: origin)
    observer.urlSession(session, dataTask: unused, didReceive: Data([1]))
    observer.urlSession(session, task: unused, didCompleteWithError: URLError(.cancelled))
    precondition(before == (try! JSONSerialization.data(withJSONObject: observer.snapshot, options: [.sortedKeys])))
    return snapshot
  }
  async let held = request("partial")
  async let healthy = request("healthz")
  _ = try await (held, healthy)
  _ = try await request("slow")
  let cancelConfig = URLSessionConfiguration.ephemeral
  cancelConfig.proxyConfigurations = [proxy]
  let cancelPin = try CertificatePinDelegate(pin: pin, origin: origin)
  let cancelObserver = StallHTTPObserver(pin: cancelPin, recorder: recorder)
  let cancelSession = URLSession(configuration: cancelConfig, delegate: cancelObserver, delegateQueue: nil)
  defer { cancelSession.invalidateAndCancel() }
  let cancelled = Task { try await cancelObserver.request(origin.appendingPathComponent("slow"), session: cancelSession) }
  cancelled.cancel()
  do { _ = try await cancelled.value; preconditionFailure("cancelled task completed successfully") }
  catch { precondition((error as NSError).code == NSURLErrorCancelled) }
  precondition(cancelObserver.snapshot["completedMs"] as? Int != nil)
  print("stall-diagnostics: partial, absent response, parallel mapping and frozen completion verified")
}
