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

@main
struct WriterStallCheck {
  static func main() async throws {
    let socket = URLSessionWebSocketTask()
    let writer = Writer(socket)
    let first = Task { try await writer.send(["type": "stream.data", "streamId": "first"]) }
    while await socket.calls == 0 { await Task.yield() }
    let second = Task { try await writer.send(["type": "stream.data", "streamId": "sibling"]) }
    // Observe the production queue, not merely whether the second Task was scheduled.
    while await writer.queuedForTest < 2 { await Task.yield() }
    try await Task.sleep(for: .milliseconds(100))
    let callsWhileBlocked = await socket.calls
    await socket.release()
    try await first.value
    try await second.value
    guard callsWhileBlocked == 1, await socket.calls == 2 else {
      print("writer-stall-not-reproduced")
      exit(1)
    }
    print("writer-stall-reproduced: sibling waits until blocked send is released")
  }
}
