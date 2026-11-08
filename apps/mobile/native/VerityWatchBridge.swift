internal import ExpoModulesCore

/// JavaScript surface of the Apple Watch inbox (lib/watchCapture.ts). Expo finds
/// inline modules by file name, so this class must match the file name.
class VerityWatchBridge: Module {
  public func definition() -> ModuleDefinition {
    Name("VerityWatchBridge")
    Events("onWatchInbox")

    OnStartObserving {
      VerityWatchInbox.shared.observe { [weak self] in self?.sendEvent("onWatchInbox", [:]) }
    }
    OnStopObserving {
      VerityWatchInbox.shared.observe(nil)
    }

    AsyncFunction("pending") { () -> [[String: Any]] in
      VerityWatchInbox.shared.transcribed()
    }
    AsyncFunction("acknowledge") { (id: String) in
      VerityWatchInbox.shared.acknowledge(id)
    }
    AsyncFunction("setProjects") {
      (scope: String?, projects: [[String: String]], lastProjectId: String?) in
      VerityWatchInbox.shared.setProjects(
        scope: scope, projects: projects, lastProjectId: lastProjectId)
    }
    AsyncFunction("pendingAnswers") { () -> [[String: Any]] in
      VerityWatchInbox.shared.pendingAnswers()
    }
    AsyncFunction("acknowledgeAnswer") { (id: String) in
      VerityWatchInbox.shared.acknowledgeAnswer(id)
    }
    /// The direct, pinned connection native code uses to reach Verity while the
    /// app is in the background; nil when there is none.
    AsyncFunction("setLink") { (link: [String: String]?) in
      guard let link, let baseUrl = link["baseUrl"], let token = link["token"],
        let tlsPin = link["tlsPin"], let scope = link["scope"]
      else {
        VerityWatchInbox.shared.setLink(nil)
        return
      }
      VerityWatchInbox.shared.setLink(
        VerityAssistantLink.Config(baseUrl: baseUrl, token: token, tlsPin: tlsPin, scope: scope))
    }
    AsyncFunction("setVerity") { (snapshot: [String: Any]?) in
      VerityWatchInbox.shared.setVerity(snapshot)
    }
    AsyncFunction("setInbox") { (inbox: [String: Any]?) in
      VerityWatchInbox.shared.setInbox(inbox)
    }
    AsyncFunction("discardWaiting") { () -> Int in
      VerityWatchInbox.shared.discardWaiting()
    }
    AsyncFunction("log") { () -> [String] in
      VerityWatchInbox.shared.logLines()
    }
    AsyncFunction("status") { () -> [String: Any] in
      VerityWatchInbox.shared.status()
    }
  }
}
