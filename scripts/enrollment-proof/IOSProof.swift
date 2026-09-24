// Test-only iOS application; never linked into the shipping app.
import UIKit
import Security
import CryptoKit

@main
final class EnrollmentProofApp: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    DispatchQueue.global().async {
      let env = ProcessInfo.processInfo.environment
      guard let phase = env["VERITY_PROOF_PHASE"], let service = env["VERITY_PROOF_SERVICE"] else { return }
      let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      let result = directory.appendingPathComponent("result.txt")
      do {
        try Self.run(phase, service, directory)
        try "success".write(to: result, atomically: true, encoding: .utf8)
      } catch {
        try? "failure: \(error)".write(to: result, atomically: true, encoding: .utf8)
      }
    }
    return true
  }
  static func check(_ condition: Bool, _ message: String) throws {
    if !condition { throw NSError(domain: message, code: 1) }
  }
  static func run(_ phase: String, _ service: String, _ directory: URL) throws {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: "device-proof",
      kSecAttrSynchronizable as String: false]
    let publicFile = directory.appendingPathComponent("public.bin")
    if phase == "create" {
      let key = Curve25519.Signing.PrivateKey()
      var item = query
      item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      item[kSecValueData as String] = key.rawRepresentation
      let status = SecItemAdd(item as CFDictionary, nil)
      try check(status == errSecSuccess, "create OSStatus=\(status)")
      try key.publicKey.rawRepresentation.write(to: publicFile, options: .atomic)
      return
    }
    try check(phase == "verify", "unknown phase")
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecReturnAttributes as String] = true
    var value: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &value)
    try check(status == errSecSuccess, "read OSStatus=\(status)")
    guard let row = value as? [String: Any], let data = row[kSecValueData as String] as? Data else {
      throw NSError(domain: "missing key data", code: 1)
    }
    try check((row[kSecAttrAccessible as String] as? String) ==
      (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String), "device-only accessibility")
    // Unlike the legacy macOS probe, missing iOS attributes fail this check.
    guard let sync = row[kSecAttrSynchronizable as String] as? NSNumber else {
      throw NSError(domain: "missing synchronizable attribute", code: 1)
    }
    try check(!sync.boolValue, "synchronizable")
    let key = try Curve25519.Signing.PrivateKey(rawRepresentation: data)
    let expected = try Data(contentsOf: publicFile)
    try check(key.publicKey.rawRepresentation == expected, "key changed across launch")
    let message = Data("verity.enrollment.ios-restart-proof".utf8)
    let signature = try key.signature(for: message)
    try check(key.publicKey.isValidSignature(signature, for: message), "signing")
    let otherKey = Curve25519.Signing.PrivateKey()
    try check(!otherKey.publicKey.isValidSignature(signature, for: message), "wrong-key rejection")
    try check(SecItemDelete(query as CFDictionary) == errSecSuccess, "delete")
    var deleted: CFTypeRef?
    try check(SecItemCopyMatching(lookup as CFDictionary, &deleted) == errSecItemNotFound, "deletion")
  }
}
