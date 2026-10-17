import Foundation
import Network

@main
@available(macOS 14.0, *)
struct LateAttachmentCheck {
  static func tunnel() throws -> RemoteAppTunnel {
    try RemoteAppTunnel(dataURL: URL(string: "wss://localhost/data")!,
      coreURL: URL(string: "https://localhost")!)
  }

  static func rejectLate(_ tunnel: RemoteAppTunnel) async throws {
    do {
      _ = try await tunnel.testLateAttachment()
      throw CheckFailure.revived
    } catch RemoteSmokeError.closed {
      guard tunnel.testListener == nil else { throw CheckFailure.leaked }
    }
  }

  static func main() async {
    do {
      // The validated reply resumes only after deadline cleanup has completed.
      let expired = try tunnel()
      expired.stop(cause: .attachmentDeadline)
      try await rejectLate(expired)
      expired.stop()
      try await rejectLate(expired)

      // A replacement owns its own listener; the old reply cannot revive it.
      let replacement = try tunnel()
      let port = try await replacement.testLateAttachment()
      guard port > 0, let listener = replacement.testListener else {
        throw CheckFailure.normalAttach
      }
      try await rejectLate(expired)
      guard replacement.testListener === listener else { throw CheckFailure.replacement }
      replacement.stop()
      for _ in 0..<2000 {
        if case .cancelled = listener.state { break }
        try await Task.sleep(nanoseconds: 1_000_000)
      }
      guard case .cancelled = listener.state else { throw CheckFailure.leaked }
      guard replacement.testListener == nil else { throw CheckFailure.leaked }
      try await rejectLate(replacement)
      print("native-late-attachment-ok")
    } catch {
      print("native-late-attachment-rejected")
      exit(1)
    }
  }

  enum CheckFailure: Error { case revived, leaked, normalAttach, replacement }
}
