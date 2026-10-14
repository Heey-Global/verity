import Foundation

// The harness compiles the Writer body extracted from RemoteAppTunnel.swift
// against a socket whose send never completes. The deadline, not the socket,
// must end the wait; the guard in the repository only reads the source shape.
actor URLSessionWebSocketTask {
  enum Message { case string(String) }
  private(set) var calls = 0

  func send(_ message: Message) async throws {
    calls += 1
    await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
  }
}

final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var raised = false
  func raise() { lock.lock(); raised = true; lock.unlock() }
  var value: Bool { lock.lock(); defer { lock.unlock() }; return raised }
}

@main
struct WriterDeadlineCheck {
  static func main() async throws {
    let socket = URLSessionWebSocketTask()
    let writer = Writer(socket)
    let stalled = Flag()
    await writer.setOnStall { stalled.raise() }
    let started = Date()
    // Bounded by the harness, not by the deadline under test: a deadline that
    // never fires must report itself rather than wait for the host watchdog.
    let outcome = Task { () -> String in
      do {
        try await writer.send(["type": "stream.data", "streamId": "first"])
        return "writer-deadline-not-enforced"
      } catch {
        return Writer.isStall(error) ? "stalled" : "writer-deadline-wrong-error"
      }
    }
    let watchdog = Task { () -> String in
      try? await Task.sleep(for: .seconds(45))
      return "writer-deadline-not-enforced"
    }
    let result = await withTaskGroup(of: String.self) { group in
      group.addTask { await outcome.value }
      group.addTask { await watchdog.value }
      let first = await group.next() ?? "writer-deadline-not-enforced"
      group.cancelAll()
      return first
    }
    guard result == "stalled" else {
      print(result)
      exit(1)
    }
    let elapsed = Date().timeIntervalSince(started)
    guard stalled.value else {
      print("writer-deadline-hook-missing")
      exit(1)
    }
    // A sibling queued behind the stalled send fails with it rather than waiting.
    do {
      try await writer.send(["type": "stream.data", "streamId": "sibling"])
      print("writer-deadline-sibling-not-released")
      exit(1)
    } catch {}
    print("writer-deadline-enforced: send stalled after \(Int(elapsed)) s, hook raised, sibling released")
  }
}
