import Foundation

guard CommandLine.arguments.count == 4, let url = URL(string: CommandLine.arguments[1]) else {
  fatalError("usage: smoke URL PIN success|FAILURE_REASON")
}

let expected = CommandLine.arguments[3]
let delegate = try CertificatePinDelegate(pin: CommandLine.arguments[2], origin: url)
let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
let semaphore = DispatchSemaphore(value: 0)
var succeeded = false
session.dataTask(with: url) { _, response, error in
  succeeded = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
  semaphore.signal()
}.resume()
guard semaphore.wait(timeout: .now() + 10) == .success else { fatalError("request timed out") }
session.invalidateAndCancel()

if expected == "success" {
  guard succeeded else { fatalError("expected success, got \(delegate.failure ?? "URLSession failure")") }
} else {
  guard !succeeded, delegate.failure?.hasPrefix(expected) == true else {
    fatalError("expected \(expected), got \(delegate.failure ?? (succeeded ? "success" : "URLSession failure"))")
  }
}
