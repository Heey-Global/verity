#if os(watchOS)
import Foundation

/// Shared by the Watch app and its extension; no audio or project data is exposed.
enum WatchCaptureComplication {
  static let kind = "VerityQuickCapture"
  static let recordingURL = URL(string: "verity-watch://capture")!
  static let pendingKey = "pendingCaptureCount"

  static var defaults: UserDefaults? {
    // Both targets sit below the iPhone identifier; production and staging stay separate.
    guard let bundle = Bundle.main.bundleIdentifier,
      let range = bundle.range(of: ".watchkitapp") else { return nil }
    return UserDefaults(suiteName: "group.\(bundle[..<range.lowerBound]).watch-capture")
  }

  static func isRecordingURL(_ url: URL) -> Bool {
    url.scheme == recordingURL.scheme && url.host == recordingURL.host
      && (url.path.isEmpty || url.path == "/") && url.query == nil && url.fragment == nil
  }
}
#endif
