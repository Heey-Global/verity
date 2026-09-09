import CryptoKit
import Foundation
import Security

final class CertificatePinDelegate: NSObject, URLSessionDelegate, URLSessionWebSocketDelegate {
  private let expectedDigest: Data
  private let expectedOrigin: URL
  private let failureLock = NSLock()
  private var storedFailure: String?
  private var storedPhase = "NO_AUTH_CHALLENGE"
  var onOpen: (() -> Void)?
  var onClose: ((String?) -> Void)?

  var failure: String? {
    failureLock.lock()
    defer { failureLock.unlock() }
    return storedFailure
  }

  var phase: String {
    failureLock.lock()
    defer { failureLock.unlock() }
    return storedPhase
  }

  private func recordPhase(_ phase: String) {
    failureLock.lock()
    storedPhase = phase
    failureLock.unlock()
  }

  private func reject(
    _ reason: String,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    failureLock.lock()
    storedFailure = reason
    failureLock.unlock()
    completionHandler(.cancelAuthenticationChallenge, nil)
  }

  private static func effectivePort(_ url: URL) -> Int? {
    if let port = url.port { return port }
    return url.scheme == "https" ? 443 : nil
  }

  init(pin: String, origin: URL) throws {
    guard pin.hasPrefix("sha256-"), let digest = Data(base64URLEncoded: String(pin.dropFirst(7))), digest.count == 32 else {
      throw CertificatePinError.invalidPin
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

  private func answer(
    _ challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    recordPhase("AUTH_CHALLENGE_RECEIVED")
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    guard
      let trust = challenge.protectionSpace.serverTrust,
      let certificate = SecTrustGetCertificateAtIndex(trust, 0),
      let publicKey = SecCertificateCopyKey(certificate),
      let attributes = SecKeyCopyAttributes(publicKey) as? [CFString: Any],
      attributes[kSecAttrKeyType] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
      attributes[kSecAttrKeySizeInBits] as? Int == 256,
      let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?
    else {
      reject("CERTIFICATE_KEY_UNAVAILABLE", completionHandler: completionHandler)
      return
    }

    // The installer pins the 65-byte uncompressed ANSI X9.63 P-256 point. Apple
    // normally returns that exact representation, but Security may expose the
    // enclosing DER SubjectPublicKeyInfo on some OS paths.
    let p256SPKIPrefix = Data([
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ])
    let point: Data
    if publicKeyData.count == 65 {
      point = publicKeyData
    } else if publicKeyData.count == 91, publicKeyData.starts(with: p256SPKIPrefix) {
      point = publicKeyData.suffix(65)
    } else {
      reject("UNSUPPORTED_KEY_FORMAT", completionHandler: completionHandler)
      return
    }
    guard point.first == 0x04 else {
      reject("UNSUPPORTED_KEY_FORMAT", completionHandler: completionHandler)
      return
    }
    guard Data(SHA256.hash(data: point)) == expectedDigest else {
      reject("PIN_MISMATCH", completionHandler: completionHandler)
      return
    }

    // URLCredential(trust:) alone does not make the private certificate trusted
    // on iOS: CFNetwork evaluates the same SecTrust again after this callback and
    // returns -1200 even though the exact invitation pin matched. Trust the root
    // delivered with the pinned leaf for this challenge only, while retaining an
    // SSL policy for the explicitly requested host. Anchoring the CA rather than
    // the CA:false leaf matters on iOS, whose later CFNetwork evaluation rejects
    // a leaf used as its own trust anchor even after SecTrust accepted a basic
    // X.509 evaluation. The leaf pin above still decides the server identity; a
    // sibling certificate from this private CA never reaches this trust path.
    let certificateCount = SecTrustGetCertificateCount(trust)
    guard
      certificateCount > 1,
      let anchor = SecTrustGetCertificateAtIndex(trust, certificateCount - 1)
    else {
      reject("CERTIFICATE_CHAIN_UNAVAILABLE", completionHandler: completionHandler)
      return
    }
    let sslHostname = expectedOrigin.host.map { $0 as CFString }
    var trustError: CFError?
    guard
      SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, sslHostname)) == errSecSuccess,
      SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
      SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
      SecTrustEvaluateWithError(trust, &trustError)
    else {
      let detail = trustError.map { CFErrorCopyDescription($0) as String } ?? "UNKNOWN"
      reject("PINNED_LEAF_TRUST_FAILED:\(detail)", completionHandler: completionHandler)
      return
    }
    recordPhase("PIN_AND_CHAIN_TRUST_ACCEPTED")
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) { answer(challenge, completionHandler: completionHandler) }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) { answer(challenge, completionHandler: completionHandler) }

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

enum CertificatePinError: Error { case invalidPin }

extension Data {
  init?(base64URLEncoded value: String) {
    var standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    standard += String(repeating: "=", count: (4 - standard.count % 4) % 4)
    self.init(base64Encoded: standard)
  }
}
