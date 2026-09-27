import Darwin
import Foundation
import Network

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
        let (_, response) = try await client.data(from: coreURL)
        guard let http = response as? HTTPURLResponse else { throw RemoteSmokeError.invalidFrame }
        status = http.statusCode
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
