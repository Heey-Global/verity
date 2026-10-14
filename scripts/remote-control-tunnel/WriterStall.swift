import Foundation

// The harness compiles the Writer body extracted from RemoteAppTunnel.swift.
// Only the WebSocket boundary is substituted; no network connection is opened.
actor URLSessionWebSocketTask {
  enum Message { case string(String) }
  private var held: CheckedContinuation<Void, Never>?
  private(set) var calls = 0

  func send(_ message: Message) async throws {
    calls += 1
    if calls == 1 {
      await withCheckedContinuation { held = $0 }
    }
  }

  func release() {
    held?.resume()
    held = nil
  }
}

// A send that is held must not hold its sibling: streams are independent on
// the way out, and a chain across them is the shape of a one-way silence.
@main
struct WriterStallCheck {
  static func main() async throws {
    let socket = URLSessionWebSocketTask()
    let writer = Writer(socket)
    let recorder = StallDiagnostics()
    let started = StallDiagnostics.now()
    recorder.opened("first", port: 1001)
    recorder.opened("sibling", port: 1002)
    await writer.setStallDiagnostics(recorder)
    let first = Task { try await writer.send(["type": "stream.data", "streamId": "first"]) }
    while await socket.calls == 0 { await Task.yield() }
    let second = Task { try await writer.send(["type": "stream.data", "streamId": "sibling"]) }
    // The sibling reaches the socket while the first send is still held.
    while await socket.calls < 2 {
      try await Task.sleep(for: .milliseconds(10))
      if StallDiagnostics.now() - started > 5 { break }
    }
    let callsWhileHeld = await socket.calls
    let blocked = recorder.snapshot(ports: [1001], since: started)
    // Judged before anything is awaited: a sibling held behind the first send
    // would only come back after the deadline, as a stall, or not at all.
    guard callsWhileHeld == 2 else {
      print("writer-chain-reintroduced")
      exit(1)
    }
    try await second.value
    let siblingDone = recorder.snapshot(ports: [1002], since: started)
    await socket.release()
    try await first.value
    guard blocked["sending"] as? Int == 1, siblingDone["completed"] as? Int == 1 else {
      print("writer-diagnostics-not-reproduced")
      exit(1)
    }
    print("writer-independent: sibling sent while the first send was held")
  }
}
