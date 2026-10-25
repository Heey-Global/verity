internal import ExpoModulesCore
import CryptoKit
import Foundation
import Network

private enum PinnedTransportError: Error {
  case invalidURL
  case invalidBody
  case nonHTTPResponse
  case invalidIdentity
  case invalidProxyMode
}

// GenericException stores its parameter but deliberately has no default reason.
// Throwing it directly crosses the Expo bridge as "undefined reason", hiding the
// URLSession code and the last TLS delegate phase needed to diagnose device-only
// failures.
private final class PinnedTransportException: GenericException<String>, @unchecked Sendable {
  override var reason: String { param }
  override var code: String { "ERR_PINNED_TRANSPORT" }
}

class VerityPinnedTransport: Module, @unchecked Sendable {
  private var webSockets: [String: (URLSession, URLSessionWebSocketTask, CertificatePinDelegate)] = [:]
  private let webSocketsLock = NSLock()
  private var requests: [String: PinnedHTTPRequest] = [:]
  private let httpPool = PinnedHTTPSessionPool()
  private let transportTimings = PinnedTransportTimingRegistry()
  private let requestsLock = NSLock()
  // How URLSession speaks to the loopback tunnel. Both dialects carry the same
  // pinned TLS bytes; the app switches when one of them fails the Core probe on
  // a device, since the two take different paths through the system proxy code.
  private var proxyMode = "socks"
  private let proxyModeLock = NSLock()

  private func configuration(proxyPort: Int) throws -> URLSessionConfiguration {
    guard proxyPort >= 0 && proxyPort <= 65_535 else { throw PinnedTransportError.invalidURL }
    let configuration = URLSessionConfiguration.ephemeral
    if proxyPort > 0 {
      guard #available(iOS 17.0, macOS 14.0, *) else { throw PinnedTransportError.invalidURL }
      guard let port = NWEndpoint.Port(rawValue: UInt16(proxyPort)) else {
        throw PinnedTransportError.invalidURL
      }
      proxyModeLock.lock()
      let mode = proxyMode
      proxyModeLock.unlock()
      configuration.proxyConfigurations = [
        mode == "connect"
          ? ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: port))
          : ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: port))
      ]
    }
    return configuration
  }

  private func currentProxyMode() -> String {
    proxyModeLock.lock()
    defer { proxyModeLock.unlock() }
    return proxyMode
  }

  private func storeRequest(_ request: PinnedHTTPRequest, id: String) {
    requestsLock.lock()
    requests[id] = request
    requestsLock.unlock()
  }

  private func finishRequest(_ id: String, request: PinnedHTTPRequest) {
    requestsLock.lock()
    if requests[id] === request { requests.removeValue(forKey: id) }
    requestsLock.unlock()
    request.finish()
  }

  private func takeRequest(_ id: String) -> PinnedHTTPRequest? {
    requestsLock.lock()
    defer { requestsLock.unlock() }
    return requests.removeValue(forKey: id)
  }

  private func performRequest(
    id: String, request: URLRequest, tlsPin: String, proxyPort: Int, upload: URL? = nil, timing: PinnedTransportTiming? = nil
  ) async throws -> (Data, HTTPURLResponse) {
    let lane = PinnedHTTPTransportLane(headers: request.allHTTPHeaderFields ?? [:])
    var request = request
    PinnedHTTPTransportLane.removeHeader(from: &request)
    guard let origin = request.url else { throw PinnedTransportError.invalidURL }
    let delegate = try CertificatePinDelegate(pin: tlsPin, origin: origin)
    delegate.transportTiming = timing
    let lease = try httpPool.acquire(
      origin: origin, pin: tlsPin, proxyPort: proxyPort, proxyMode: currentProxyMode(), lane: lane)
    defer { lease.release() }
    let record = PinnedHTTPRequest(delegate: delegate)
    let result: (Data, URLResponse)
    do {
      result = try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<(Data, URLResponse), Error>) in
        let completion: @Sendable (Data?, URLResponse?, Error?) -> Void = { data, response, error in
          timing?.completed(error: error)
          self.finishRequest(id, request: record)
          if let error { continuation.resume(throwing: error) }
          else if let response { continuation.resume(returning: (data ?? Data(), response)) }
          else { continuation.resume(throwing: PinnedTransportError.nonHTTPResponse) }
        }
        let task: URLSessionDataTask
        if let upload {
          task = lease.session.uploadTask(with: request, fromFile: upload, completionHandler: completion)
        } else {
          task = lease.session.dataTask(with: request, completionHandler: completion)
        }
        task.delegate = delegate
        record.install(task)
        self.storeRequest(record, id: id)
        timing?.resumed()
        task.resume()
      }
    } catch {
      if let failure = delegate.failure {
        throw PinnedTransportException("Pinned TLS verification failed [\(failure)].")
      }
      throw PinnedTransportException(
        CertificatePinDelegate.transportFailure(error: error as NSError, phase: delegate.phase))
    }
    guard let response = result.1 as? HTTPURLResponse else { throw PinnedTransportError.nonHTTPResponse }
    return (result.0, response)
  }

  private func requestResponse(
    requestId: String, url: String, method: String, headers: [String: String], bodyBase64: String?,
    tlsPin: String, proxyPort: Int, preferText: Bool
  ) async throws -> [String: Any] {
    let timing = PinnedTransportTiming(
      headers: headers, proxyPort: proxyPort, proxyMode: currentProxyMode())
    if let timing { transportTimings.retain(timing) }
    guard let target = URL(string: url), target.scheme == "https", target.user == nil, target.password == nil else {
      throw PinnedTransportError.invalidURL
    }
    var request = URLRequest(url: target)
    request.httpMethod = method
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    if let bodyBase64 {
      guard let body = Data(base64Encoded: bodyBase64) else { throw PinnedTransportError.invalidBody }
      request.httpBody = body
    }
    let (data, response) = try await performRequest(
      id: requestId, request: request, tlsPin: tlsPin, proxyPort: proxyPort, timing: timing)
    var result = pinnedHTTPResponse(data: data, response: response, preferText: preferText)
    // Never wait for metrics: the bounded export includes a later delegate callback.
    if let timing {
      timing.responseReady()
      result["transportTiming"] = timing.snapshot()
    }
    return result
  }

  private func socket(
    _ id: String
  ) -> (URLSession, URLSessionWebSocketTask, CertificatePinDelegate)? {
    webSocketsLock.lock()
    defer { webSocketsLock.unlock() }
    return webSockets[id]
  }

  private func storeSocket(
    _ value: (URLSession, URLSessionWebSocketTask, CertificatePinDelegate), id: String
  ) {
    webSocketsLock.lock()
    webSockets[id] = value
    webSocketsLock.unlock()
  }

  @discardableResult
  private func removeSocket(
    _ id: String
  ) -> (URLSession, URLSessionWebSocketTask, CertificatePinDelegate)? {
    webSocketsLock.lock()
    defer { webSocketsLock.unlock() }
    return webSockets.removeValue(forKey: id)
  }

  public func definition() -> ModuleDefinition {
    Name("VerityPinnedTransport")
    Events("onWebSocketEvent")

    OnDestroy {
      self.requestsLock.lock()
      let requests = Array(self.requests.values)
      self.requests.removeAll()
      self.requestsLock.unlock()
      requests.forEach { $0.cancel() }
      self.httpPool.shutdown()
      self.webSocketsLock.lock()
      let sockets = Array(self.webSockets.values)
      self.webSockets.removeAll()
      self.webSocketsLock.unlock()
      sockets.forEach { $0.0.invalidateAndCancel() }
    }

    Function("exportTransportTimings") { self.transportTimings.snapshot() }

    AsyncFunction("request") {
      (requestId: String, url: String, method: String, headers: [String: String], bodyBase64: String?, tlsPin: String, proxyPort: Int) async throws
        -> [String: Any] in
      return try await self.requestResponse(
        requestId: requestId, url: url, method: method, headers: headers, bodyBase64: bodyBase64,
        tlsPin: tlsPin, proxyPort: proxyPort, preferText: false)
    }

    AsyncFunction("requestV2") {
      (requestId: String, url: String, method: String, headers: [String: String], bodyBase64: String?, tlsPin: String, proxyPort: Int) async throws
        -> [String: Any] in
      return try await self.requestResponse(
        requestId: requestId, url: url, method: method, headers: headers, bodyBase64: bodyBase64,
        tlsPin: tlsPin, proxyPort: proxyPort, preferText: true)
    }

    Function("supportsTransportLanes") { true }

    AsyncFunction("download") {
      (url: String, headers: [String: String], destination: String, tlsPin: String, proxyPort: Int) async throws
        -> [String: Any] in
      guard
        let target = URL(string: url), target.scheme == "https", target.user == nil,
        target.password == nil,
        let destinationURL = URL(string: destination), destinationURL.isFileURL
      else { throw PinnedTransportError.invalidURL }
      var request = URLRequest(url: target)
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      let lane = PinnedHTTPTransportLane(headers: headers)
      PinnedHTTPTransportLane.removeHeader(from: &request)
      let delegate = try CertificatePinDelegate(pin: tlsPin, origin: target)
      let lease = try self.httpPool.acquire(
        origin: target, pin: tlsPin, proxyPort: proxyPort, proxyMode: self.currentProxyMode(), lane: lane)
      defer { lease.release() }
      let (temporaryURL, response) = try await lease.session.download(for: request, delegate: delegate)
      guard let http = response as? HTTPURLResponse else { throw PinnedTransportError.nonHTTPResponse }
      guard (200...299).contains(http.statusCode) else {
        return ["status": http.statusCode, "uri": destinationURL.absoluteString]
      }
      let manager = FileManager.default
      try manager.createDirectory(
        at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      if manager.fileExists(atPath: destinationURL.path) { try manager.removeItem(at: destinationURL) }
      try manager.moveItem(at: temporaryURL, to: destinationURL)
      return ["status": http.statusCode, "uri": destinationURL.absoluteString]
    }

    AsyncFunction("upload") {
      (requestId: String, url: String, method: String, headers: [String: String], source: String, tlsPin: String, proxyPort: Int) async throws
        -> [String: Any] in
      guard
        let target = URL(string: url), target.scheme == "https", target.user == nil,
        target.password == nil, let sourceURL = URL(string: source), sourceURL.isFileURL
      else { throw PinnedTransportError.invalidURL }
      var request = URLRequest(url: target)
      request.httpMethod = method
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      let (data, response) = try await self.performRequest(
        id: requestId, request: request, tlsPin: tlsPin, proxyPort: proxyPort, upload: sourceURL)
      return pinnedHTTPResponse(data: data, response: response, preferText: false)
    }

    AsyncFunction("setProxyMode") { (mode: String) in
      guard mode == "socks" || mode == "connect" else { throw PinnedTransportError.invalidProxyMode }
      self.proxyModeLock.lock()
      self.proxyMode = mode
      self.proxyModeLock.unlock()
    }

    AsyncFunction("cancelRequest") { (requestId: String) async -> String? in
      let entry = self.takeRequest(requestId)
      entry?.cancel()
      // URLSession delivers task metrics on its delegate queue, often only as
      // cancellation completes. Only the explicit diagnostic waits for them.
      if requestId.hasPrefix("remote-probe-") {
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      return entry?.delegate.connectionDiagnostic
    }

    AsyncFunction("verifyIdentity") {
      (identityKey: String, serverId: String, challenge: String, signature: String) throws -> Bool in
      guard
        let subjectPublicKeyInfo = Data(base64URLEncoded: identityKey),
        let signatureData = Data(base64URLEncoded: signature),
        subjectPublicKeyInfo.count == 44
      else { throw PinnedTransportError.invalidIdentity }
      let ed25519Prefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
      guard subjectPublicKeyInfo.prefix(ed25519Prefix.count) == ed25519Prefix else {
        throw PinnedTransportError.invalidIdentity
      }
      let key = try Curve25519.Signing.PublicKey(rawRepresentation: subjectPublicKeyInfo.suffix(32))
      let transcript = Data("verity.device-pairing.v1\0\(serverId)\0\(challenge)".utf8)
      return key.isValidSignature(signatureData, for: transcript)
    }

    AsyncFunction("openWebSocket") { (url: String, tlsPin: String, protocols: [String], proxyPort: Int) throws -> String in
      guard let target = URL(string: url), target.scheme == "wss", target.user == nil, target.password == nil else {
        throw PinnedTransportError.invalidURL
      }
      let id = UUID().uuidString
      let delegate = try CertificatePinDelegate(pin: tlsPin, origin: target)
      delegate.onOpen = { [weak self] in self?.sendEvent("onWebSocketEvent", ["id": id, "type": "open"]) }
      delegate.onClose = { [weak self] code, reason in
        self?.sendEvent("onWebSocketEvent", ["id": id, "type": "close", "code": code, "data": reason ?? ""])
        self?.removeSocket(id)?.0.finishTasksAndInvalidate()
      }
      let session = URLSession(configuration: try self.configuration(proxyPort: proxyPort), delegate: delegate, delegateQueue: nil)
      var request = URLRequest(url: target)
      if !protocols.isEmpty {
        request.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
      }
      let task = session.webSocketTask(with: request)
      storeSocket((session, task, delegate), id: id)
      // Defer the first event until the async bridge has returned the id to JS;
      // otherwise a very fast local connection can emit `open` before JS can
      // associate the listener with this socket.
      DispatchQueue.main.async { [weak self] in
        guard self?.socket(id) != nil else { return }
        task.resume()
        self?.receiveNextWebSocketMessage(id: id)
      }
      return id
    }

    // The live connection talks back (subscriptions, foreground state, pings).
    // A failed send surfaces through the receive loop, which closes the socket.
    AsyncFunction("sendWebSocket") { (id: String, text: String) in
      guard let (_, task, _) = self.socket(id) else { return }
      task.send(.string(text)) { _ in }
    }

    AsyncFunction("closeWebSocket") { (id: String) in
      guard let (session, task, _) = self.removeSocket(id) else { return }
      task.cancel(with: .normalClosure, reason: nil)
      session.finishTasksAndInvalidate()
    }
  }

  private func receiveNextWebSocketMessage(id: String) {
    guard let (_, task, _) = socket(id) else { return }
    Task { [weak self] in
      do {
        let message = try await task.receive()
        guard let self, self.socket(id) != nil else { return }
        switch message {
        case .string(let text):
          self.sendEvent("onWebSocketEvent", ["id": id, "type": "message", "data": text])
        case .data(let data):
          self.sendEvent("onWebSocketEvent", ["id": id, "type": "message", "data": data.base64EncodedString()])
        @unknown default:
          self.sendEvent("onWebSocketEvent", ["id": id, "type": "error", "data": "Unknown WebSocket frame"])
        }
        self.receiveNextWebSocketMessage(id: id)
      } catch {
        guard let self, let (session, _, _) = self.removeSocket(id) else { return }
        session.finishTasksAndInvalidate()
        self.sendEvent("onWebSocketEvent", ["id": id, "type": "error", "data": error.localizedDescription])
        self.sendEvent("onWebSocketEvent", ["id": id, "type": "close", "code": task.closeCode.rawValue, "data": error.localizedDescription])
      }
    }
  }
}
