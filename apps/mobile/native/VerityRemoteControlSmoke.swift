internal import ExpoModulesCore
import Foundation

class VerityRemoteControlSmoke: Module {
  public func definition() -> ModuleDefinition {
    Name("VerityRemoteControlSmoke")

    AsyncFunction("requestOnce") {
      (dataURLText: String, ticket: String, sessionId: String, coreURLText: String, corePin: String) async throws
        -> [String: Any] in
      guard #available(iOS 17.0, macOS 14.0, *) else { throw RemoteSmokeError.invalidInput }
      guard let dataURL = URL(string: dataURLText), let coreURL = URL(string: coreURLText),
        coreURL.scheme == "https", coreURL.user == nil, coreURL.password == nil
      else { throw RemoteSmokeError.invalidInput }
      let (status, body) = try await RemoteSmokeTunnel.requestOnce(
        dataURL: dataURL, ticket: ticket, sessionId: sessionId, coreURL: coreURL, corePin: corePin)
      return ["status": status, "bodyBase64": body.base64EncodedString()]
    }
  }
}
