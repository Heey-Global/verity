import Foundation

private enum HTTPPoolSmokeFailure: Error { case failed(String) }
private func checkPool(_ condition: Bool, _ message: String) throws {
  if !condition { throw HTTPPoolSmokeFailure.failed(message) }
}

private final class HTTPPoolSmokeResult: @unchecked Sendable {
  let done = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var result: (Data?, URLResponse?, Error?)?
  func complete(data: Data?, response: URLResponse?, error: Error?) {
    lock.lock()
    result = (data, response, error)
    lock.unlock()
    done.signal()
  }
  func wait() throws -> (Data?, URLResponse?, Error?) {
    guard done.wait(timeout: .now() + 15) == .success else {
      throw HTTPPoolSmokeFailure.failed("pooled request timed out")
    }
    lock.lock()
    defer { lock.unlock() }
    guard let result else { throw HTTPPoolSmokeFailure.failed("missing pooled result") }
    return result
  }
}

private func pooledTask(session: URLSession, url: URL, pin: String) throws
  -> (PinnedHTTPRequest, HTTPPoolSmokeResult)
{
  let delegate = try CertificatePinDelegate(pin: pin, origin: url)
  let record = PinnedHTTPRequest(delegate: delegate)
  let result = HTTPPoolSmokeResult()
  let task = session.dataTask(with: url) { data, response, error in
    record.finish()
    result.complete(data: data, response: response, error: error)
  }
  task.delegate = delegate
  record.install(task)
  task.resume()
  return (record, result)
}

/// Exercises the production pool and task cancellation on both macOS and iOS.
func verifyPinnedHTTPPool(origin: URL, pin: String) throws {
  let pool = PinnedHTTPSessionPool()
  defer { pool.shutdown() }
  do {
    _ = try pool.acquire(origin: origin, pin: "invalid", proxyPort: 0, proxyMode: "socks")
    throw HTTPPoolSmokeFailure.failed("pool accepted an invalid pin")
  } catch CertificatePinError.invalidPin { }
  let first = try pool.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "socks")
  defer { first.release() }
  try checkPool(first.session.delegate == nil, "pooled session shared request authentication diagnostics")
  let same = try pool.acquire(
    origin: origin.appendingPathComponent("path"), pin: pin, proxyPort: 0, proxyMode: "socks")
  defer { same.release() }
  try checkPool(first.session === same.session, "same origin/pin/route did not reuse session")
  let wrongPin = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  let otherPin = try pool.acquire(origin: origin, pin: wrongPin, proxyPort: 0, proxyMode: "socks")
  defer { otherPin.release() }
  try checkPool(first.session !== otherPin.session, "different pins shared TLS connections")
  var changedPort = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
  changedPort.port = (origin.port ?? 443) + 1
  let port = try pool.acquire(origin: changedPort.url!, pin: pin, proxyPort: 0, proxyMode: "socks")
  defer { port.release() }
  try checkPool(first.session !== port.session, "different origins shared sessions")
  let mode = try pool.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "connect")
  defer { mode.release() }
  try checkPool(first.session !== mode.session, "different proxy modes shared sessions")
  let proxy = try pool.acquire(origin: origin, pin: pin, proxyPort: 18445, proxyMode: "socks")
  defer { proxy.release() }
  try checkPool(first.session !== proxy.session, "different proxy ports shared sessions")

  // A warm TLS connection must not make a new pin succeed without verification.
  let firstTask = try pooledTask(session: first.session, url: origin, pin: pin)
  let initial = try firstTask.1.wait()
  try checkPool(initial.2 == nil && (initial.1 as? HTTPURLResponse)?.statusCode == 200,
    "pooled per-task pin delegate did not accept trusted server: \(firstTask.0.delegate.failure ?? "no pin rejection")")
  let secondTask = try pooledTask(session: same.session, url: origin, pin: pin)
  let reused = try secondTask.1.wait()
  try checkPool(firstTask.0.delegate !== secondTask.0.delegate, "requests reused a mutable pin delegate")
  let initialPeer = (initial.1 as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Smoke-Peer-Port")
  let reusedPeer = (reused.1 as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Smoke-Peer-Port")
  try checkPool(reused.2 == nil && initialPeer != nil && reusedPeer == initialPeer,
    "sequential pooled requests did not reuse the HTTP connection")
  let rejectedTask = try pooledTask(session: otherPin.session, url: origin, pin: wrongPin)
  let rejected = try rejectedTask.1.wait()
  try checkPool(rejected.2 != nil && rejectedTask.0.delegate.failure == "PIN_MISMATCH",
    "pooled wrong-pin connection was accepted or rejected for the wrong reason")
  try checkPool(firstTask.0.delegate.failure == nil && secondTask.0.delegate.failure == nil,
    "pin rejection contaminated another request's diagnostics")

  let slow = origin.appendingPathComponent("slow")
  let cancelled = try pooledTask(session: first.session, url: slow, pin: pin)
  let survivor = try pooledTask(session: first.session, url: slow, pin: pin)
  cancelled.0.cancel()
  let aborted = try cancelled.1.wait()
  try checkPool((aborted.2 as NSError?)?.code == NSURLErrorCancelled,
    "request cancellation did not cancel its task")
  let survived = try survivor.1.wait()
  try checkPool(survived.2 == nil && (survived.1 as? HTTPURLResponse)?.statusCode == 200,
    "cancelling one request interrupted another request in the pooled session")
  let afterCancel = try pooledTask(session: first.session, url: origin, pin: pin)
  let healthy = try afterCancel.1.wait()
  try checkPool(healthy.2 == nil, "cancelled task invalidated pooled session")

  // Destruction must include sessions kept outside the full cache while leased.
  let liveShutdown = PinnedHTTPSessionPool(capacity: 1)
  let cachedLease = try liveShutdown.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "socks")
  let overflowLease = try liveShutdown.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "connect")
  let overflowTask = try pooledTask(session: overflowLease.session, url: slow, pin: pin)
  liveShutdown.shutdown()
  let overflowResult = try overflowTask.1.wait()
  try checkPool((overflowResult.2 as NSError?)?.code == NSURLErrorCancelled,
    "pool destruction left an uncached leased request running")
  cachedLease.release()
  overflowLease.release()

  let bounded = PinnedHTTPSessionPool(capacity: 1)
  let held = try bounded.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "socks")
  let overflow = try bounded.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "connect")
  overflow.release()
  let overflowAgain = try bounded.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "connect")
  try checkPool(overflow.session !== overflowAgain.session, "active overflow escaped the cache bound")
  overflowAgain.release()
  held.release()
  let replacement = try bounded.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "connect")
  let evicted = try bounded.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "socks")
  try checkPool(evicted.session !== held.session, "idle session was not evicted")
  replacement.release()
  evicted.release()
  bounded.shutdown()
  do {
    _ = try bounded.acquire(origin: origin, pin: pin, proxyPort: 0, proxyMode: "socks")
    throw HTTPPoolSmokeFailure.failed("destroyed pool accepted new requests")
  } catch let failure as HTTPPoolSmokeFailure { throw failure }
  catch { /* Shutdown must reject even a cache hit. */ }

  for mediaType in ["text/plain", "Application/JSON; charset=utf-8", "application/problem+json"] {
    let response = HTTPURLResponse(url: origin, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": mediaType])!
    let text = "\u{FEFF}\u{FEFF}Plötzlich größer 🐈"
    let decoded = pinnedHTTPResponse(data: Data(text.utf8), response: response, preferText: true)
    try checkPool(decoded["bodyText"] as? String == text && decoded["bodyBase64"] == nil,
      "native textual response lost UTF-8/BOM or crossed the bridge as base64")
    let legacy = pinnedHTTPResponse(data: Data(text.utf8), response: response, preferText: false)
    try checkPool(legacy["bodyBase64"] as? String == Data(text.utf8).base64EncodedString(),
      "legacy response contract changed")
    let malformed = pinnedHTTPResponse(data: Data([0x66, 0x80]), response: response, preferText: true)
    try checkPool(malformed["bodyText"] as? String == "f\u{FFFD}", "malformed UTF-8 was not replaced")
  }
  let binary = Data([0, 255, 128])
  let response = HTTPURLResponse(url: origin, statusCode: 200, httpVersion: nil,
    headerFields: ["Content-Type": "application/octet-stream"])!
  let encoded = pinnedHTTPResponse(data: binary, response: response, preferText: true)
  try checkPool(encoded["bodyBase64"] as? String == binary.base64EncodedString() && encoded["bodyText"] == nil,
    "binary response bytes changed")
}
