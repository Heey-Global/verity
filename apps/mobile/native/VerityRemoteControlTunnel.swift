internal import ExpoModulesCore
import Foundation

class VerityRemoteControlTunnel: Module {
  private var tunnel: AnyObject?
  private var retired: [AnyObject] = []
  private var lastStartFailure: String?
  private var captureNextAttempt = false
  private var diagnosticRecords: [RemoteDataDiagnostics] = []

  @available(iOS 17.0, macOS 14.0, *)
  private func capture(_ tunnel: RemoteAppTunnel) -> Bool {
    guard tunnel.enableDataDiagnostics() else { return false }
    if !diagnosticRecords.contains(where: { $0 === tunnel.dataDiagnostics }) {
      diagnosticRecords.append(tunnel.dataDiagnostics)
      if diagnosticRecords.count > 3 { diagnosticRecords.removeFirst() }
    }
    return true
  }

  @available(iOS 17.0, macOS 14.0, *)
  private func stopTunnels(_ cause: RemoteDataDiagnostics.Cause) {
    if let tunnel = tunnel as? RemoteAppTunnel {
      tunnel.stop(cause: cause)
      _ = tunnel.exportDataDiagnostics()
    }
    tunnel = nil
    for old in retired {
      (old as? RemoteAppTunnel)?.stop(cause: cause)
    }
    retired.removeAll()
  }

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
            (self.retired.removeFirst() as? RemoteAppTunnel)?.stop(cause: .replacement)
          }
          self.retired.append(previous)
        } else { previous.stop(cause: .replacement); _ = previous.exportDataDiagnostics() }
      }
      let tunnel = try RemoteAppTunnel(dataURL: dataURL, coreURL: coreURL)
      self.tunnel = tunnel
      if self.captureNextAttempt { _ = self.capture(tunnel) }
      self.captureNextAttempt = false
      self.lastStartFailure = nil
      do { return try await tunnel.start(ticket: ticket, sessionId: sessionId) }
      catch {
        _ = tunnel.exportDataDiagnostics()
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

    AsyncFunction("diagnosticSummary") { () -> String? in
      guard #available(iOS 17.0, macOS 14.0, *) else { return nil }
      return (self.tunnel as? RemoteAppTunnel)?.diagnosticSummary
    }

    AsyncFunction("captureDataDiagnostics") { () -> Bool in
      guard #available(iOS 17.0, macOS 14.0, *) else { return false }
      if let tunnel = self.tunnel as? RemoteAppTunnel, !tunnel.isStopped {
        return self.capture(tunnel)
      }
      self.captureNextAttempt = true
      return true
    }

    AsyncFunction("clearPendingDataDiagnostics") { self.captureNextAttempt = false }

    AsyncFunction("disableDataDiagnostics") {
      self.captureNextAttempt = false
      guard #available(iOS 17.0, macOS 14.0, *) else { return }
      (self.tunnel as? RemoteAppTunnel)?.disableDataDiagnostics()
      for record in self.diagnosticRecords { record.disable() }
    }

    AsyncFunction("exportDataDiagnostics") { () -> [String] in
      guard #available(iOS 17.0, macOS 14.0, *) else { return [] }
      _ = (self.tunnel as? RemoteAppTunnel)?.exportDataDiagnostics()
      return self.diagnosticRecords.compactMap { $0.export() }
    }

    AsyncFunction("recordDataDiagnosticEvent") { (event: String) in
      guard #available(iOS 17.0, macOS 14.0, *),
        let value = RemoteDataDiagnostics.Event(rawValue: event),
        [.probeStarted, .probeSucceeded, .probeFailed, .appActive, .appBackground, .appInactive].contains(value)
      else { return }
      (self.tunnel as? RemoteAppTunnel)?.dataDiagnostics.record(value)
    }

    AsyncFunction("stopWithCause") { (cause: String) in
      guard #available(iOS 17.0, macOS 14.0, *) else { return }
      self.stopTunnels(RemoteDataDiagnostics.Cause(rawValue: cause) ?? .appStop)
    }

    AsyncFunction("isActive") { () -> Bool in
      guard #available(iOS 17.0, macOS 14.0, *) else { return false }
      return (self.tunnel as? RemoteAppTunnel)?.isActive == true
    }

    AsyncFunction("stop") {
      guard #available(iOS 17.0, macOS 14.0, *) else { return }
      self.stopTunnels(.appStop)
    }
  }
}
