import Darwin
import Foundation

@available(macOS 14.0, *)
@main
enum StagingProbe {
  static func main() async {
    do {
      let environment = ProcessInfo.processInfo.environment
      guard
        let dataURLText = environment["VERITY_REMOTE_DATA_URL"],
        let dataURL = URL(string: dataURLText),
        let ticket = environment["VERITY_REMOTE_TICKET"],
        let sessionId = environment["VERITY_REMOTE_SESSION_ID"],
        let coreURLText = environment["VERITY_REMOTE_CORE_URL"],
        let coreURL = URL(string: coreURLText),
        let corePin = environment["VERITY_REMOTE_CORE_PIN"]
      else { throw RemoteSmokeError.invalidInput }
      let (status, _) = try await RemoteSmokeTunnel.requestOnce(
        dataURL: dataURL, ticket: ticket, sessionId: sessionId, coreURL: coreURL,
        corePin: corePin,
        onAttached: {
          print("attached")
          fflush(stdout)
        })
      print("Core HTTPS status: \(status)")
    } catch {
      fputs("Remote Control staging probe failed: \(error)\n", stderr)
      exit(1)
    }
  }
}
