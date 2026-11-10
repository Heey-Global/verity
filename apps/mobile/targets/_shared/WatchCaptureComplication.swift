#if os(watchOS)
import Foundation

/// Shared launch contract for the Watch app and its complication.
enum WatchCaptureComplication {
  static let kind = "VerityQuickCapture"
  static let homeURL = URL(string: "verity-watch://home")!
  static func isHomeURL(_ url: URL) -> Bool {
    url.scheme == homeURL.scheme && (url.host == homeURL.host || url.host == "capture")
      && (url.path.isEmpty || url.path == "/") && url.query == nil && url.fragment == nil
  }
}
#endif
