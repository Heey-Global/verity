#if os(watchOS)
import Foundation

/// Shared launch contract for the Watch app and its complication.
enum WatchCaptureComplication {
  static let kind = "VerityQuickCapture"
  static let recordingURL = URL(string: "verity-watch://capture")!
  static func isRecordingURL(_ url: URL) -> Bool {
    url.scheme == recordingURL.scheme && url.host == recordingURL.host
      && (url.path.isEmpty || url.path == "/") && url.query == nil && url.fragment == nil
  }
}
#endif
