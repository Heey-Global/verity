internal import ExpoModulesCore
import Foundation

class VerityRemoteControlTunnel: Module {
  private var tunnel: AnyObject?
  private var retired: [AnyObject] = []
  private var lastStartFailure: String?

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
      self.retired.removeAll { ($0 as? RemoteAppTunnel)?.isStopped == true }
      if let previous = self.tunnel as? RemoteAppTunnel {
        if previous.isExhausted && !previous.isStopped {
          // Existing streams keep their original listener until they drain.
          if self.retired.count >= 3 {
            (self.retired.removeFirst() as? RemoteAppTunnel)?.stop()
          }
          self.retired.append(previous)
        } else { previous.stop() }
      }
      let tunnel = try RemoteAppTunnel(dataURL: dataURL, coreURL: coreURL)
      self.tunnel = tunnel
      self.lastStartFailure = nil
      do { return try await tunnel.start(ticket: ticket, sessionId: sessionId) }
      catch {
        self.tunnel = nil
        self.lastStartFailure = tunnel.stopReason ?? "attachment failed: \(error)"
        throw error
      }
    }

    AsyncFunction("lastStopReason") { () -> String? in
      guard #available(iOS 17.0, macOS 14.0, *) else { return nil }
      if let tunnel = self.tunnel as? RemoteAppTunnel { return tunnel.stopReason }
      return self.lastStartFailure
    }

    AsyncFunction("isActive") { () -> Bool in
      guard #available(iOS 17.0, macOS 14.0, *) else { return false }
      return (self.tunnel as? RemoteAppTunnel)?.isActive == true
    }

    AsyncFunction("stop") {
      guard #available(iOS 17.0, macOS 14.0, *) else { return }
      (self.tunnel as? RemoteAppTunnel)?.stop()
      self.tunnel = nil
      for old in self.retired { (old as? RemoteAppTunnel)?.stop() }
      self.retired.removeAll()
    }
  }
}
