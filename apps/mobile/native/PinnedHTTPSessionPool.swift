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

enum PinnedHTTPTransportLane: String {
  case interactive
  case background

  /// Unknown and absent metadata retain the conservative background pool.
  init(headers: [String: String]) {
    let value = headers.first { $0.key.lowercased() == "x-verity-transport-lane" }?.value
    self = value.flatMap(Self.init(rawValue:)) ?? .background
  }

  static func removeHeader(from request: inout URLRequest) {
    request.setValue(nil, forHTTPHeaderField: "x-verity-transport-lane")
  }
}

private struct PinnedHTTPSessionKey: Hashable {
  let host: String
  let port: Int
  let pin: String
  let proxyPort: Int
  let proxyMode: String
  let lane: PinnedHTTPTransportLane
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

  func acquire(origin: URL, pin: String, proxyPort: Int, proxyMode: String, lane: PinnedHTTPTransportLane = .background) throws
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
      proxyPort: proxyPort, proxyMode: proxyMode, lane: lane)
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

/// Content-free, bounded device-clock diagnostics. Timer gaps are scheduling intervals,
/// not evidence that JavaScript or a native thread was continuously executing.
final class PinnedTransportTiming: @unchecked Sendable {
  private let lock = NSLock()
  private let entry = ProcessInfo.processInfo.systemUptime
  private let entryDate = Date()
  private var fields: [String: Any]

  init?(headers: [String: String], proxyPort: Int, proxyMode: String) {
    guard let id = headers.first(where: { $0.key.lowercased() == "x-verity-switch-request" })?.value,
      id.range(of: "^[a-z0-9-]{1,80}$", options: .regularExpression) == (id.startIndex..<id.endIndex)
    else { return nil }
    fields = ["requestId": id, "metricsAvailable": false,
      "nativeEntryWallMs": entryDate.timeIntervalSince1970 * 1000,
      "route": proxyPort > 0 ? "tunnel" : "direct",
      "proxyMode": proxyPort > 0 ? proxyMode : "none"]
  }

  func resumed() {
    lock.lock()
    fields["nativeResumeMs"] = (ProcessInfo.processInfo.systemUptime - entry) * 1000
    lock.unlock()
  }

  func completed(error: Error?) {
    lock.lock()
    fields["nativeCompletionMs"] = (ProcessInfo.processInfo.systemUptime - entry) * 1000
    fields["nativeCompletionWallMs"] = Date().timeIntervalSince1970 * 1000
    fields["failed"] = error != nil
    lock.unlock()
  }

  func responseReady() {
    lock.lock()
    fields["nativeResponseReadyMs"] = (ProcessInfo.processInfo.systemUptime - entry) * 1000
    fields["nativeResponseReadyWallMs"] = Date().timeIntervalSince1970 * 1000
    lock.unlock()
  }

  func collected(_ metrics: URLSessionTaskMetrics) {
    // URLSession dates share the device wall clock, not the server clock. Do not
    // combine these offsets with server timestamps without clock calibration.
    func offset(_ date: Date?) -> Double? {
      date.map { $0.timeIntervalSince(entryDate) * 1000 }
    }
    let transactions: [[String: Any]] = metrics.transactionMetrics.suffix(4).map { tx in
      var value: [String: Any] = ["reusedConnection": tx.isReusedConnection,
        "proxyConnection": tx.isProxyConnection]
      let knownProtocols: Set<String> = ["http/1.0", "http/1.1", "h2", "h3"]
      value["protocol"] = knownProtocols.contains(tx.networkProtocolName ?? "")
        ? tx.networkProtocolName : "other"
      let dates: [(String, Date?)] = [
        ("fetchStartMs", tx.fetchStartDate), ("dnsStartMs", tx.domainLookupStartDate),
        ("dnsEndMs", tx.domainLookupEndDate), ("connectStartMs", tx.connectStartDate),
        ("connectEndMs", tx.connectEndDate), ("tlsStartMs", tx.secureConnectionStartDate),
        ("tlsEndMs", tx.secureConnectionEndDate), ("requestStartMs", tx.requestStartDate),
        ("requestEndMs", tx.requestEndDate), ("responseStartMs", tx.responseStartDate),
        ("responseEndMs", tx.responseEndDate)]
      for (name, date) in dates { if let elapsed = offset(date) { value[name] = elapsed } }
      return value
    }
    lock.lock()
    fields["metricsAvailable"] = true
    fields["transactionCount"] = metrics.transactionMetrics.count
    fields["transactionsTruncated"] = metrics.transactionMetrics.count > 4
    fields["transactions"] = transactions
    lock.unlock()
  }

  func snapshot() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return fields
  }
}

final class PinnedTransportTimingRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var records: [PinnedTransportTiming] = []
  private var omitted = 0
  func retain(_ record: PinnedTransportTiming) {
    lock.lock()
    records.append(record)
    if records.count > 32 {
      let excess = records.count - 32
      omitted += excess
      records.removeFirst(excess)
    }
    lock.unlock()
  }
  func snapshot() -> [String: Any] {
    lock.lock()
    let retained = records
    let dropped = omitted
    lock.unlock()
    return ["records": retained.map { $0.snapshot() }, "omitted": dropped]
  }
}
