import Darwin
import Foundation
import Network

enum ProbeFailure: Error {
  case tunnelStopped(String)
}

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
      let status: Int
      if environment["VERITY_REMOTE_PROBE_MODE"] == "app" {
        let tunnel = try RemoteAppTunnel(dataURL: dataURL, coreURL: coreURL)
        let port = try await tunnel.start(ticket: ticket, sessionId: sessionId)
        defer { tunnel.stop() }
        print("attached")
        fflush(stdout)
        guard (1...65_535).contains(port),
          let localPort = NWEndpoint.Port(rawValue: UInt16(port))
        else { throw RemoteSmokeError.invalidInput }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12
        config.proxyConfigurations = [
          ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: localPort))
        ]
        let delegate = try CertificatePinDelegate(pin: corePin, origin: coreURL)
        let client = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { client.invalidateAndCancel() }
        // A pause longer than the data heartbeat interval is the case a
        // few-second probe never saw: an attachment that dies while idle.
        let idleSeconds = UInt64(environment["VERITY_REMOTE_PROBE_IDLE_SECONDS"] ?? "0") ?? 0
        var lastStatus = 0
        for attempt in 0..<3 {
          if attempt == 2 && idleSeconds > 0 {
            print("idling \(idleSeconds)s")
            fflush(stdout)
            try await Task.sleep(nanoseconds: idleSeconds * 1_000_000_000)
          }
          guard tunnel.isActive else {
            throw ProbeFailure.tunnelStopped(tunnel.stopReason ?? "unknown")
          }
          let response: URLResponse
          do {
            let result = try await client.data(for: URLRequest(url: coreURL))
            response = result.1
          } catch {
            throw ProbeFailure.tunnelStopped(
              CertificatePinDelegate.transportFailure(error: error as NSError, phase: delegate.phase))
          }
          guard let http = response as? HTTPURLResponse, http.statusCode == 200,
            tunnel.isActive
          else { throw ProbeFailure.tunnelStopped(tunnel.stopReason ?? "bad response") }
          lastStatus = http.statusCode
        }
        // An HTTP success must also exercise the production tunnel's byte accounting.
        let summary = tunnel.diagnosticSummary
        for field in ["sentBytes", "receivedBytes", "deliveredBytes"] {
          guard summary.range(of: "\(field)=[1-9][0-9]*", options: .regularExpression) != nil
          else { throw RemoteSmokeError.invalidFrame }
        }
        print("App tunnel: \(summary)")
        status = lastStatus
      } else {
        let response = try await RemoteSmokeTunnel.requestOnce(
          dataURL: dataURL, ticket: ticket, sessionId: sessionId, coreURL: coreURL,
          corePin: corePin,
          onAttached: {
            print("attached")
            fflush(stdout)
          })
        status = response.0
      }
      guard status == 200 else { throw RemoteSmokeError.invalidFrame }
      print("Core HTTPS status: \(status)")
    } catch {
      fputs("Remote Control staging probe failed: \(error)\n", stderr)
      exit(1)
    }
  }
}
