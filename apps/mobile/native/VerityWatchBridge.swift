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
    AsyncFunction("log") { () -> [String] in
      VerityWatchInbox.shared.logLines()
    }
    AsyncFunction("status") { () -> [String: Any] in
      VerityWatchInbox.shared.status()
    }
  }
}
