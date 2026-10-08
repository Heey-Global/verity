import Foundation
import Network

final class PinnedHTTPRequest: @unchecked Sendable {
  let delegate: CertificatePinDelegate
  private let lock = NSLock()
  private var task: URLSessionTask?

  init(delegate: CertificatePinDelegate) { self.delegate = delegate }
  func install(_ task: URLSessionTask) {
    lock.lock()
    self.task = task
    lock.unlock()
  }
  func cancel() {
    lock.lock()
    let current = task
    lock.unlock()
    current?.cancel()
  }
  func finish() {
    lock.lock()
    task = nil
    lock.unlock()
  }
}

private struct PinnedHTTPSessionKey: Hashable {
  let host: String
  let port: Int
  let pin: String
  let proxyPort: Int
  let proxyMode: String
}

final class PinnedHTTPSessionLease: @unchecked Sendable {
  let session: URLSession
  private let lock = NSLock()
  private var releaseAction: (() -> Void)?

  init(session: URLSession, release: @escaping () -> Void) {
    self.session = session
    releaseAction = release
  }

  func release() {
    lock.lock()
    let action = releaseAction
    releaseAction = nil
    lock.unlock()
    action?()
  }

  deinit { release() }
}

/// The pin and route partition connections even when URLSession can reuse TLS.
/// Leases keep eviction from invalidating a session before its task is created.
final class PinnedHTTPSessionPool: @unchecked Sendable {
  private final class Entry {
    let session: URLSession
    var users = 0
    var lastUsed: UInt64 = 0
    var cached = true
    init(session: URLSession) { self.session = session }
  }
  private let lock = NSLock()
  private var entries: [PinnedHTTPSessionKey: Entry] = [:]
  private var overflowEntries: [ObjectIdentifier: Entry] = [:]
  private var clock: UInt64 = 0
  private var closed = false
  private let capacity: Int

  init(capacity: Int = 8) { self.capacity = max(1, capacity) }

  func acquire(origin: URL, pin: String, proxyPort: Int, proxyMode: String) throws
    -> PinnedHTTPSessionLease
  {
    guard origin.scheme == "https", let host = origin.host,
      origin.user == nil, origin.password == nil,
      proxyPort >= 0, proxyPort <= 65_535,
      proxyMode == "socks" || proxyMode == "connect"
    else { throw URLError(.badURL) }
    // Validate even on a cache hit, before a reused TLS connection can hide a bad pin.
    _ = try CertificatePinDelegate(pin: pin, origin: origin)
    let key = PinnedHTTPSessionKey(
      host: host.lowercased(), port: origin.port ?? 443, pin: pin,
      proxyPort: proxyPort, proxyMode: proxyMode)
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { throw URLError(.cancelled) }
    clock &+= 1
    let entry: Entry
    if let cached = entries[key] {
      entry = cached
    } else {
      if entries.count >= capacity,
        let oldest = entries.filter({ $0.value.users == 0 })
          .min(by: { $0.value.lastUsed < $1.value.lastUsed })
      {
        entries.removeValue(forKey: oldest.key)
        oldest.value.cached = false
        oldest.value.session.finishTasksAndInvalidate()
      }
      let configuration = URLSessionConfiguration.ephemeral
      // A pooled session must not share response cookies or auth credentials between requests.
      configuration.httpCookieStorage = nil
      configuration.urlCredentialStorage = nil
      configuration.urlCache = nil
      if proxyPort > 0 {
        guard #available(iOS 17.0, macOS 14.0, *),
          let port = NWEndpoint.Port(rawValue: UInt16(proxyPort))
        else { throw URLError(.badURL) }
        configuration.proxyConfigurations = [
          proxyMode == "connect"
            ? ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: port))
            : ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: port))
        ]
      }
      // No session authentication delegate: each task's fresh pin delegate handles
      // TLS challenges, redirects and metrics, without stale cross-request diagnostics.
      entry = Entry(session: URLSession(configuration: configuration))
      if entries.count < capacity { entries[key] = entry }
      else {
        entry.cached = false
        overflowEntries[ObjectIdentifier(entry)] = entry
      } // active overflow is retired when its lease ends
    }
    entry.users += 1
    entry.lastUsed = clock
    return PinnedHTTPSessionLease(session: entry.session) { [weak self] in
      if let self { self.release(entry) }
      else { entry.session.finishTasksAndInvalidate() }
    }
  }

  private func release(_ entry: Entry) {
    lock.lock()
    entry.users -= 1
    let retire = !entry.cached && entry.users == 0
    if retire { overflowEntries.removeValue(forKey: ObjectIdentifier(entry)) }
    lock.unlock()
    if retire { entry.session.finishTasksAndInvalidate() }
  }

  /// Route/pin changes already get distinct keys; destruction cancels every pooled task.
  func shutdown() {
    lock.lock()
    closed = true
    let activeEntries = Array(entries.values) + Array(overflowEntries.values)
    let sessions = activeEntries.map(\.session)
    activeEntries.forEach { $0.cached = false }
    entries.removeAll()
    overflowEntries.removeAll()
    lock.unlock()
    sessions.forEach { $0.invalidateAndCancel() }
  }

  deinit { shutdown() }
}

/// Version two moves text decoding off the JavaScript thread; old bridges keep base64.
func pinnedHTTPResponse(data: Data, response: HTTPURLResponse, preferText: Bool) -> [String: Any] {
  var headers: [String: String] = [:]
  for (name, value) in response.allHeaderFields {
    if let name = name as? String { headers[name] = String(describing: value) }
  }
  let contentType = response.value(forHTTPHeaderField: "Content-Type")?
    .split(separator: ";", maxSplits: 1).first?
    .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  var result: [String: Any] = ["status": response.statusCode, "headers": headers]
  if preferText, let contentType,
    contentType.hasPrefix("text/") || contentType == "application/json" || contentType.hasSuffix("+json")
  {
    // Preserve BOMs here; JavaScript removes exactly one to match TextDecoder.
    result["bodyText"] = String(decoding: data, as: UTF8.self)
  } else { result["bodyBase64"] = data.base64EncodedString() }
  return result
}
