import Foundation

guard CommandLine.arguments.count == 4, let url = URL(string: CommandLine.arguments[1]) else {
  fatalError("usage: smoke URL PIN success|FAILURE_REASON")
}

let expected = CommandLine.arguments[3]
let delegate = try CertificatePinDelegate(pin: CommandLine.arguments[2], origin: url)
let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
let semaphore = DispatchSemaphore(value: 0)
var succeeded = false
var receivedError: Error?
session.dataTask(with: url) { _, response, error in
  receivedError = error
  succeeded = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
  semaphore.signal()
}.resume()
guard semaphore.wait(timeout: .now() + 10) == .success else { fatalError("request timed out") }
session.invalidateAndCancel()

// A rejection the delegate never saw carries its reason only in the NSError, so
// both outcomes report it: the wrong-failure case is the one where the harness
// itself is being fooled.
let native =
  receivedError.map { error -> String in
    let value = error as NSError
    let details = value.userInfo
      .map { key, value in "\(key)=\(String(describing: value))" }
      .sorted()
      .joined(separator: ", ")
    return "\(value.domain):\(value.code) {\(details)}"
  } ?? "no NSError"

if expected == "success" {
  guard succeeded else {
    fatalError("expected success, got \(delegate.failure ?? "URLSession failure"); \(native); phase=\(delegate.phase)")
  }
} else {
  guard !succeeded, delegate.failure?.hasPrefix(expected) == true else {
    let actual = delegate.failure ?? (succeeded ? "success" : "URLSession failure")
    fatalError("expected \(expected), got \(actual); \(native); phase=\(delegate.phase)")
  }
}
