internal import ExpoModulesCore
import Foundation

class VerityRemoteControlTunnel: Module {
  private var tunnel: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("VerityRemoteControlTunnel")

    AsyncFunction("isSupported") { () -> Bool in
      if #available(iOS 17.0, macOS 14.0, *) { return true }
      return false
    }

    AsyncFunction("start") {
      (dataURLText: String, ticket: String, sessionId: String, coreURLText: String) async throws
        -> Int in
      guard #available(iOS 17.0, macOS 14.0, *) else { throw RemoteSmokeError.invalidInput }
      guard let dataURL = URL(string: dataURLText), let coreURL = URL(string: coreURLText)
      else { throw RemoteSmokeError.invalidInput }
      (self.tunnel as? RemoteAppTunnel)?.stop()
      let tunnel = try RemoteAppTunnel(dataURL: dataURL, coreURL: coreURL)
      self.tunnel = tunnel
      do { return try await tunnel.start(ticket: ticket, sessionId: sessionId) }
      catch {
        self.tunnel = nil
        throw error
      }
    }

    AsyncFunction("isActive") { () -> Bool in
      guard #available(iOS 17.0, macOS 14.0, *) else { return false }
      return (self.tunnel as? RemoteAppTunnel)?.isActive == true
    }

    AsyncFunction("stop") {
      guard #available(iOS 17.0, macOS 14.0, *) else { return }
      (self.tunnel as? RemoteAppTunnel)?.stop()
      self.tunnel = nil
    }
  }
}
