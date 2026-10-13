import Foundation

// Compiled only into probe binaries. No frame bodies, addresses or wire IDs
// leave this recorder; stream IDs and local ports are internal lookup keys.
final class StallDiagnostics: @unchecked Sendable {
  struct Stream {
    let id: String
    let port: UInt16
    let opened: TimeInterval
    var completed = 0
    var failed = 0
  }
  struct Send {
    let stream: String
    let enqueued: TimeInterval
    var started: TimeInterval?
  }
  private let lock = NSLock()
  private var streams: [Stream] = []
  private var sends: [Int: Send] = [:]
  private var sequence = 0
  private var lostSend = false
  private var evictedThrough: TimeInterval = -1
  static let streamLimit = 64
  static let sendLimit = 128
  static func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

  func opened(_ id: String, port: UInt16) {
    lock.withLock {
      if streams.count == Self.streamLimit {
        evictedThrough = max(evictedThrough, streams.removeFirst().opened)
      }
      streams.append(Stream(id: id, port: port, opened: Self.now()))
    }
  }
  func enqueue(_ stream: String) -> Int? {
    lock.withLock {
      guard sends.count < Self.sendLimit, sequence < 1_000_000_000 else {
        lostSend = true
        return nil
      }
      sequence += 1
      sends[sequence] = Send(stream: stream, enqueued: Self.now())
      return sequence
    }
  }
  func started(_ token: Int?) {
    lock.withLock { if let token { sends[token]?.started = Self.now() } }
  }
  func finished(_ token: Int?, failed: Bool) {
    lock.withLock {
      guard let token, let send = sends.removeValue(forKey: token),
        let index = streams.firstIndex(where: { $0.id == send.stream }) else { return }
      if failed { streams[index].failed = min(1_000_000_000, streams[index].failed + 1) }
      else { streams[index].completed = min(1_000_000_000, streams[index].completed + 1) }
    }
  }
  func snapshot(ports: Set<UInt16>, since: TimeInterval) -> [String: Any] {
    lock.withLock {
      let matches = streams.filter { ports.contains($0.port) && $0.opened >= since }
      let overflow = lostSend || evictedThrough >= since
      let known = !overflow && ports.count == 1 && matches.count == 1
      let selected = known ? matches[0] : nil
      let pending = sends.values.filter { $0.stream == selected?.id }
      let active = sends.values.filter { $0.started != nil }
      let age = active.map { Self.now() - ($0.started ?? $0.enqueued) }.max() ?? 0
      return ["mapping": overflow ? "overflow" : known ? "matched" : matches.count > 1 || ports.count > 1 ? "ambiguous" : "unknown",
        "queued": known ? pending.filter { $0.started == nil }.count : -1,
        "sending": known ? pending.filter { $0.started != nil }.count : -1,
        "completed": selected?.completed ?? -1, "failed": selected?.failed ?? -1,
        "globalQueued": sends.values.filter { $0.started == nil }.count,
        "globalSending": active.count, "oldestSendMs": min(86_400_000, max(0, Int(age * 1000))),
        "overflow": overflow]
    }
  }
}

