internal import ExpoModulesCore
import CryptoKit
import Foundation
import Security

private enum PinnedTransportError: Error {
  case invalidURL
  case invalidPin
  case invalidBody
  case nonHTTPResponse
  case invalidIdentity
}

final class CertificatePinDelegate: NSObject, URLSessionDelegate, URLSessionWebSocketDelegate {
  private let expectedDigest: Data
  private let expectedOrigin: URL
  var onOpen: (() -> Void)?
  var onClose: ((String?) -> Void)?

  private static func effectivePort(_ url: URL) -> Int? {
    if let port = url.port { return port }
    return url.scheme == "https" ? 443 : nil
  }

  init(pin: String, origin: URL) throws {
    guard pin.hasPrefix("sha256-"), let digest = Data(base64URLEncoded: String(pin.dropFirst(7))), digest.count == 32 else {
      throw PinnedTransportError.invalidPin
    }
    expectedDigest = digest
    expectedOrigin = origin
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard
      let target = request.url,
      target.scheme == "https",
      target.host == expectedOrigin.host,
      Self.effectivePort(target) == Self.effectivePort(expectedOrigin),
      target.user == nil,
      target.password == nil
    else {
      completionHandler(nil)
      return
    }
    completionHandler(request)
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard
      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let certificate = SecTrustGetCertificateAtIndex(trust, 0),
      let publicKey = SecCertificateCopyKey(certificate),
      let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let actualDigest = Data(SHA256.hash(data: publicKeyData))
    guard actualDigest == expectedDigest else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    // The installer's stable P-256 TLS key is the authority. Certificates can be
    // renewed and IP endpoints changed without weakening the pin.
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) { onOpen?() }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) { onClose?(reason.flatMap { String(data: $0, encoding: .utf8) }) }
}

private extension Data {
  init?(base64URLEncoded value: String) {
    var standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    standard += String(repeating: "=", count: (4 - standard.count % 4) % 4)
    self.init(base64Encoded: standard)
  }
}

class VerityPinnedTransport: Module {
  private var webSockets: [String: (URLSession, URLSessionWebSocketTask, CertificatePinDelegate)] = [:]
  private let webSocketsLock = NSLock()
  private var requests: [String: URLSession] = [:]
  private let requestsLock = NSLock()

  private func storeRequest(_ session: URLSession, id: String) {
    requestsLock.lock()
    requests[id] = session
    requestsLock.unlock()
  }

  private func finishRequest(_ id: String) {
    requestsLock.lock()
    requests.removeValue(forKey: id)
    requestsLock.unlock()
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

    AsyncFunction("request") {
      (requestId: String, url: String, method: String, headers: [String: String], bodyBase64: String?, tlsPin: String) async throws
        -> [String: Any] in
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
      let delegate = try CertificatePinDelegate(pin: tlsPin, origin: target)
      let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
      self.storeRequest(session, id: requestId)
      defer {
        self.finishRequest(requestId)
        session.finishTasksAndInvalidate()
      }
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { throw PinnedTransportError.nonHTTPResponse }
      var responseHeaders: [String: String] = [:]
      for (name, value) in http.allHeaderFields {
        guard let name = name as? String else { continue }
        responseHeaders[name] = String(describing: value)
      }
      return [
        "status": http.statusCode,
        "headers": responseHeaders,
        "bodyBase64": data.base64EncodedString(),
      ]
    }

    AsyncFunction("download") {
      (url: String, headers: [String: String], destination: String, tlsPin: String) async throws
        -> [String: Any] in
      guard
        let target = URL(string: url), target.scheme == "https", target.user == nil,
        target.password == nil,
        let destinationURL = URL(string: destination), destinationURL.isFileURL
      else { throw PinnedTransportError.invalidURL }
      var request = URLRequest(url: target)
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      let delegate = try CertificatePinDelegate(pin: tlsPin, origin: target)
      let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
      defer { session.finishTasksAndInvalidate() }
      let (temporaryURL, response) = try await session.download(for: request)
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
      (requestId: String, url: String, method: String, headers: [String: String], source: String, tlsPin: String) async throws
        -> [String: Any] in
      guard
        let target = URL(string: url), target.scheme == "https", target.user == nil,
        target.password == nil, let sourceURL = URL(string: source), sourceURL.isFileURL
      else { throw PinnedTransportError.invalidURL }
      var request = URLRequest(url: target)
      request.httpMethod = method
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      let delegate = try CertificatePinDelegate(pin: tlsPin, origin: target)
      let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
      self.storeRequest(session, id: requestId)
      defer {
        self.finishRequest(requestId)
        session.finishTasksAndInvalidate()
      }
      let (data, response) = try await session.upload(for: request, fromFile: sourceURL)
      guard let http = response as? HTTPURLResponse else { throw PinnedTransportError.nonHTTPResponse }
      var responseHeaders: [String: String] = [:]
      for (name, value) in http.allHeaderFields {
        guard let name = name as? String else { continue }
        responseHeaders[name] = String(describing: value)
      }
      return [
        "status": http.statusCode,
        "headers": responseHeaders,
        "bodyBase64": data.base64EncodedString(),
      ]
    }

    AsyncFunction("cancelRequest") { (requestId: String) in
      self.requestsLock.lock()
      let session = self.requests.removeValue(forKey: requestId)
      self.requestsLock.unlock()
      session?.invalidateAndCancel()
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

    AsyncFunction("openWebSocket") { (url: String, tlsPin: String, protocols: [String]) throws -> String in
      guard let target = URL(string: url), target.scheme == "wss", target.user == nil, target.password == nil else {
        throw PinnedTransportError.invalidURL
      }
      let id = UUID().uuidString
      let delegate = try CertificatePinDelegate(pin: tlsPin, origin: target)
      delegate.onOpen = { [weak self] in self?.sendEvent("onWebSocketEvent", ["id": id, "type": "open"]) }
      delegate.onClose = { [weak self] reason in
        self?.sendEvent("onWebSocketEvent", ["id": id, "type": "close", "data": reason ?? ""])
        self?.removeSocket(id)?.0.finishTasksAndInvalidate()
      }
      let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
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
        self.sendEvent("onWebSocketEvent", ["id": id, "type": "close", "data": error.localizedDescription])
      }
    }
  }
}
