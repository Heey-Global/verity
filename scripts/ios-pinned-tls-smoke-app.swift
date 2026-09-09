import Foundation
import UIKit

@main
final class PinnedTLSSmokeApp: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    DispatchQueue.global(qos: .userInitiated).async {
      let environment = ProcessInfo.processInfo.environment
      guard
        let origin = environment["VERITY_SMOKE_ORIGIN"],
        let pin = environment["VERITY_SMOKE_PIN"],
        let resultPath = environment["VERITY_SMOKE_RESULT"]
      else {
        Self.finish("missing smoke environment", at: "/tmp/verity-pinned-tls-result")
      }

      let cases = [
        (origin, pin, "success"),
        (origin, "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "PIN_MISMATCH"),
        (origin.replacingOccurrences(of: "127.0.0.1", with: "localhost"), pin,
         "PINNED_CHAIN_TRUST_FAILED"),
      ]
      var failures: [String] = []
      for (url, candidatePin, expected) in cases {
        let actual = Self.request(url: url, pin: candidatePin)
        if expected == "success" ? actual != "success" : !actual.hasPrefix(expected) {
          failures.append("expected \(expected) for \(url), got \(actual)")
        }
      }
      Self.finish(failures.isEmpty ? "success" : failures.joined(separator: "\n"), at: resultPath)
    }
    return true
  }

  private static func request(url value: String, pin: String) -> String {
    guard let url = URL(string: value) else { return "invalid URL" }
    do {
      let delegate = try CertificatePinDelegate(pin: pin, origin: url)
      let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
      let semaphore = DispatchSemaphore(value: 0)
      var outcome = "no callback"
      session.dataTask(with: url) { _, response, error in
        if error == nil, (response as? HTTPURLResponse)?.statusCode == 200 {
          outcome = "success"
        } else if let failure = delegate.failure {
          outcome = failure
        } else if let error {
          let native = error as NSError
          let details = native.userInfo
            .map { key, value in "\(key)=\(String(describing: value))" }
            .sorted()
            .joined(separator: ", ")
          outcome = "\(native.domain):\(native.code) {\(details)}; phase=\(delegate.phase)"
        } else {
          outcome = "non-200 response; phase=\(delegate.phase)"
        }
        semaphore.signal()
      }.resume()
      guard semaphore.wait(timeout: .now() + 15) == .success else {
        session.invalidateAndCancel()
        return "request timed out; phase=\(delegate.phase)"
      }
      session.invalidateAndCancel()
      return outcome
    } catch {
      return "delegate setup failed: \(error)"
    }
  }

  private static func finish(_ result: String, at path: String) -> Never {
    try? Data(result.utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
    exit(result == "success" ? EXIT_SUCCESS : EXIT_FAILURE)
  }
}
