// Test-only macOS Keychain and CryptoKit probe. Never linked into the app.
import Foundation
import Security
import CryptoKit

func require(_ ok: Bool, _ label: String) throws {
  if !ok { throw NSError(domain: label, code: 1) }
}
func decode(_ text: String) -> Data {
  let s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  return Data(base64Encoded: s + String(repeating: "=", count: (4 - s.count % 4) % 4))!
}
let args = CommandLine.arguments
// Unique service ID is supplied by the runner, so no existing app keys are touched.
let service = args[2]
var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service, kSecAttrAccount as String: "probe",
  kSecAttrSynchronizable as String: false]
if let path = ProcessInfo.processInfo.environment["VERITY_PROBE_KEYCHAIN"] {
  var keychain: SecKeychain?
  try require(SecKeychainOpen(path, &keychain) == errSecSuccess, "open test keychain")
  guard let keychain else { fatalError("missing test keychain") }
  if args[1] == "create" {
    query[kSecUseKeychain as String] = keychain
  } else {
    // Reads and deletes select an explicit search list; kSecUseKeychain selects
    // the destination for insertion and does not scope a matching query.
    query[kSecMatchSearchList as String] = [keychain]
  }
}
if args[1] == "delete" {
  let status = SecItemDelete(query as CFDictionary)
  try require(status == errSecSuccess || status == errSecItemNotFound, "delete")
} else if args[1] == "create" {
  let key = Curve25519.Signing.PrivateKey()
  var item = query
  item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
  item[kSecValueData as String] = key.rawRepresentation
  try require(SecItemAdd(item as CFDictionary, nil) == errSecSuccess, "add")
  try key.publicKey.rawRepresentation.write(to: URL(fileURLWithPath: args[3]))
} else {
  var lookup = query
  lookup[kSecReturnData as String] = true
  lookup[kSecReturnAttributes as String] = true
  var result: CFTypeRef?
  let status = SecItemCopyMatching(lookup as CFDictionary, &result)
  try require(status == errSecSuccess, "read OSStatus=\(status)")
  let row = result as! [String: Any]
  try require((row[kSecAttrAccessible as String] as? String) == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String), "accessibility")
  try require((row[kSecAttrSynchronizable as String] as? NSNumber)?.boolValue != true, "sync")
  let key = try Curve25519.Signing.PrivateKey(rawRepresentation: row[kSecValueData as String] as! Data)
  let saved = try Data(contentsOf: URL(fileURLWithPath: args[3]))
  try require(key.publicKey.rawRepresentation == saved, "restart key identity")
  let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[4]))) as! [String: Any]
  let fields = vector["fields"] as! [Any]
  let message = try JSONSerialization.data(withJSONObject: fields, options: [.withoutEscapingSlashes])
  let hex = message.map { String(format: "%02x", $0) }.joined()
  try require(hex == vector["hex"] as! String, "cross-language transcript")
  let publicDER = decode(fields[7] as! String)
  let pub = try Curve25519.Signing.PublicKey(rawRepresentation: publicDER.suffix(32))
  try require(pub.isValidSignature(decode(vector["signature"] as! String), for: message), "Node signature")
  let signature = try key.signature(for: message)
  try require(key.publicKey.isValidSignature(signature, for: message), "persisted key signing")
  print("PASS: process restart, stored attributes, transcript bytes and Ed25519 vector")
}
