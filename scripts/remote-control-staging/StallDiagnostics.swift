import Foundation

// A fresh observer belongs to exactly one task. Freeze before resuming its
// continuation, so sibling cleanup cannot rewrite the first failure evidence.
final class StallHTTPObserver: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  let pin: CertificatePinDelegate
  let recorder: StallDiagnostics
  private let lock = NSLock()
  private let start = StallDiagnostics.now()
  private var headers: Int?
  private var firstByte: Int?
  private var ports: Set<UInt16> = []
  private var portOverflow = false
  private var frozen: [String: Any]?
  private var continuation: CheckedContinuation<URLResponse, Error>?
  private var task: URLSessionDataTask?
  private var cancelled = false
  init(pin: CertificatePinDelegate, recorder: StallDiagnostics) {
    self.pin = pin
    self.recorder = recorder
  }
  private func elapsed() -> Int { min(86_400_000, max(0, Int((StallDiagnostics.now() - start) * 1000))) }
  var snapshot: [String: Any] { lock.withLock { frozen ?? [:] } }
  func request(_ url: URL, session: URLSession) async throws -> URLResponse {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let task = session.dataTask(with: url)
        // Per-task ownership preserves the warmup session's connection reuse
        // while keeping response milestones isolated for each request.
        task.delegate = self
        let cancel = lock.withLock {
          self.continuation = continuation
          self.task = task
          return cancelled
        }
        task.resume()
        if cancel { task.cancel() }
      }
    } onCancel: {
      let task = self.lock.withLock { self.cancelled = true; return self.task }
      task?.cancel()
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    pin.urlSession(session, task: task, willPerformHTTPRedirection: response,
      newRequest: request, completionHandler: completionHandler)
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    pin.urlSession(session, didReceive: challenge, completionHandler: completionHandler)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    pin.urlSession(session, task: task, didReceive: challenge, completionHandler: completionHandler)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    lock.withLock { if frozen == nil && headers == nil { headers = elapsed() } }
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.withLock { if frozen == nil && firstByte == nil && !data.isEmpty { firstByte = elapsed() } }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
    pin.urlSession(session, task: task, didFinishCollecting: metrics)
    lock.withLock {
      guard frozen == nil else { return }
      for transaction in metrics.transactionMetrics {
        guard transaction.isProxyConnection,
          let address = transaction.localAddress, ["127.0.0.1", "::1"].contains(address),
          let value = transaction.localPort, value > 0, value <= 65535 else { continue }
        if ports.contains(UInt16(value)) { continue }
        if ports.count < 8 { ports.insert(UInt16(value)) }
        else { portOverflow = true }
      }
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let continuation = lock.withLock { () -> CheckedContinuation<URLResponse, Error>? in
      guard frozen == nil else { return nil }
      var writer = recorder.snapshot(ports: ports, since: start)
      if portOverflow {
        writer["mapping"] = "overflow"
        writer["overflow"] = true
        for key in ["queued", "sending", "completed", "failed"] { writer[key] = -1 }
      }
      frozen = ["headersMs": headers ?? -1, "firstByteMs": firstByte ?? -1,
        "completedMs": elapsed(), "writer": writer]
      let result = self.continuation
      self.continuation = nil
      self.task = nil
      return result
    }
    if let error { continuation?.resume(throwing: error) }
    else if let response = task.response { continuation?.resume(returning: response) }
    else { continuation?.resume(throwing: URLError(.badServerResponse)) }
  }
}
