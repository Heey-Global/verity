import Foundation

// The audio tap never waits for the main actor or for disk/network work.
final class LiveMeetingProgress: @unchecked Sendable {
  private let lock = NSLock()
  private var seconds: Double = 0
  private var lastAudio: Date?

  func capture(frames: UInt32, sampleRate: Double) -> Double {
    lock.lock()
    defer { lock.unlock() }
    let start = seconds
    seconds += Double(frames) / sampleRate
    lastAudio = Date()
    return start
  }

  func snapshot() -> (seconds: Double, lastAudio: Date?) {
    lock.lock()
    defer { lock.unlock() }
    return (seconds, lastAudio)
  }
}
