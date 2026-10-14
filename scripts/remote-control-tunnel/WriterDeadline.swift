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

final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  func raise() { lock.lock(); count += 1; lock.unlock() }
  var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}

// First answer wins; the loser is left running. A task group would wait for
// both, and the stuck send under test never finishes.
final class FirstAnswer: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<String, Never>?
  init(_ continuation: CheckedContinuation<String, Never>) { self.continuation = continuation }
  func answer(_ value: String) {
    lock.lock()
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(returning: value)
  }
}

@main
struct WriterDeadlineCheck {
  static func main() async throws {
    let socket = URLSessionWebSocketTask()
    let writer = Writer(socket)
    let stalled = Counter()
    await writer.setOnStall { stalled.raise() }
    let started = Date()
    // Bounded by the harness at twice the deadline under test, well inside
    // the host's 120 s watchdog: a deadline that never fires must report
    // itself rather than be killed.
    let result = await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
      let first = FirstAnswer(continuation)
      Task {
        do {
          try await writer.send(["type": "stream.data", "streamId": "first"])
          first.answer("writer-deadline-not-enforced")
        } catch {
          first.answer(Writer.isStall(error) ? "stalled" : "writer-deadline-wrong-error")
        }
      }
      Task {
        try? await Task.sleep(for: .seconds(Int(Writer.sendDeadlineSeconds) * 2))
        first.answer("writer-deadline-not-enforced")
      }
    }
    guard result == "stalled" else {
      print(result)
      exit(1)
    }
    let elapsed = Date().timeIntervalSince(started)
    guard stalled.value == 1 else {
      print("writer-deadline-hook-missing")
      exit(1)
    }
    // A sibling queued behind the stalled send fails with the same stall
    // rather than waiting, and does not raise the hook a second time.
    do {
      try await writer.send(["type": "stream.data", "streamId": "sibling"])
      print("writer-deadline-sibling-not-released")
      exit(1)
    } catch {
      guard Writer.isStall(error), stalled.value == 1 else {
        print("writer-deadline-sibling-wrong-failure")
        exit(1)
      }
    }
    print("writer-deadline-enforced: send stalled after \(Int(elapsed)) s, hook raised, sibling released")
  }
}
