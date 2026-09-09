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
      // Resolved before the other variables are checked: a misconfigured launch
      // reported to some other path is indistinguishable from a hang, because
      // the host only ever polls this one.
      let resultPath = environment["VERITY_SMOKE_RESULT"] ?? "/tmp/verity-pinned-tls-result"
      guard
        let origin = environment["VERITY_SMOKE_ORIGIN"],
        let wrongHostOrigin = environment["VERITY_SMOKE_WRONG_HOST_ORIGIN"],
        let pin = environment["VERITY_SMOKE_PIN"]
      else {
        Self.finish("missing smoke environment", at: resultPath)
      }

      let cases = [
        (origin, pin, "success"),
        (origin, "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "PIN_MISMATCH"),
        (wrongHostOrigin, pin, "PINNED_CHAIN_TRUST_FAILED"),
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
    do {
      try Data(result.utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
    } catch {
      // Discarding this error leaves the host waiting out its deadline for a
      // file that was never going to appear, with nothing naming the reason.
      NSLog("pinned TLS smoke could not write %@: %@", path, String(describing: error))
      exit(EXIT_FAILURE)
    }
    exit(result == "success" ? EXIT_SUCCESS : EXIT_FAILURE)
  }
}
