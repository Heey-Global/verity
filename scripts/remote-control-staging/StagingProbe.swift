import Darwin
import Foundation
import Network

enum ProbeFailure: Error {
  case tunnelStopped(String)
  case soakFailed(String)
}

// The device's pattern, not the probe's: several pinned connections at once,
// each request on a fresh URLSession as the app's transport does, for minutes.
// A three-request probe never saw the attachment that carries one stream and
// then goes silent in one direction while its socket stays open.
@available(macOS 14.0, *)
func soak(tunnel: RemoteAppTunnel, coreURL: URL, corePin: String, localPort: NWEndpoint.Port,
  seconds: UInt64, streams: Int) async throws
{
  let deadline = Date().addingTimeInterval(TimeInterval(seconds))
  let counters = SoakCounters()
  try await withThrowingTaskGroup(of: Void.self) { group in
    for worker in 0..<streams {
      group.addTask {
        // No request within its own timeout of the deadline: the soak must end
        // with its own diagnostic, not the host's watchdog.
        while Date().addingTimeInterval(12) < deadline {
          guard tunnel.isActive else {
            throw ProbeFailure.soakFailed(
              "tunnel stopped: \(tunnel.stopReason ?? "unknown"); \(tunnel.diagnosticSummary)")
          }
          let config = URLSessionConfiguration.ephemeral
          config.timeoutIntervalForRequest = 12
          config.proxyConfigurations = [
            ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: localPort))
          ]
          let delegate: CertificatePinDelegate
          do { delegate = try CertificatePinDelegate(pin: corePin, origin: coreURL) }
          catch {
            let completed = await counters.requests
            throw ProbeFailure.soakFailed("worker \(worker) after \(completed) requests: \(error)")
          }
          let client = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
          defer { client.invalidateAndCancel() }
          let started = Date()
          do {
            let (_, response) = try await client.data(for: URLRequest(url: coreURL))
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
              let completed = await counters.requests
              throw ProbeFailure.soakFailed(
                "worker \(worker) after \(completed) requests: status "
                  + "\((response as? HTTPURLResponse)?.statusCode ?? 0); \(tunnel.diagnosticSummary)")
            }
            await counters.record(Date().timeIntervalSince(started))
          } catch let failure as ProbeFailure {
            throw failure
          } catch {
            let completed = await counters.requests
            throw ProbeFailure.soakFailed(
              "worker \(worker) after \(completed) requests: "
                + CertificatePinDelegate.transportFailure(error: error as NSError, phase: delegate.phase)
                + "; \(tunnel.diagnosticSummary)")
          }
          // A reading user, not a load test: half a second to two seconds between requests.
          let pause = min(Double.random(in: 0.5...2), max(0, deadline.timeIntervalSinceNow))
          try await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
        }
      }
    }
    try await group.waitForAll()
  }
  let requests = await counters.requests
  let maxMs = await counters.maxMs
  // A soak that issued nothing proves nothing; it must not read as a pass.
  guard requests >= streams else {
    throw ProbeFailure.soakFailed("only \(requests) requests completed across \(streams) streams")
  }
  print("Soak: requests=\(requests) streams=\(streams) seconds=\(seconds) maxMs=\(maxMs)")
  fflush(stdout)
}

actor SoakCounters {
  var requests = 0
  var maxMs = 0
  func record(_ seconds: TimeInterval) {
    requests += 1
    maxMs = max(maxMs, Int(seconds * 1000))
  }
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
        // Unparsable values fail rather than skip: a soak that silently did
        // not run would leave the run green.
        guard let soakSeconds = UInt64(environment["VERITY_REMOTE_PROBE_SOAK_SECONDS"] ?? "0"),
          let soakStreams = Int(environment["VERITY_REMOTE_PROBE_SOAK_STREAMS"] ?? "4"),
          soakSeconds == 0 || (30...600).contains(soakSeconds), (1...8).contains(soakStreams)
        else { throw RemoteSmokeError.invalidInput }
        if soakSeconds > 0 {
          print("soaking \(soakSeconds)s with \(soakStreams) streams")
          fflush(stdout)
          try await soak(tunnel: tunnel, coreURL: coreURL, corePin: corePin, localPort: localPort,
            seconds: soakSeconds, streams: soakStreams)
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
    } catch ProbeFailure.soakFailed(let detail) {
      // The worker, request count, native cause and tunnel summary, as promised.
      fputs("Remote Control staging soak failed: \(detail)\n", stderr)
      exit(1)
    } catch {
      fputs("Remote Control staging probe failed: \(error)\n", stderr)
      exit(1)
    }
  }
}
