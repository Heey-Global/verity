import Foundation

/// Written before bridge delivery: a suspended JavaScript runtime must not lose recognition results.
@MainActor
final class LiveMeetingJournal {
  static let shared = LiveMeetingJournal()

  private struct Metadata: Codable {
    var meetingId: String
    var nextSequence: Int
    var acknowledgedSequence: Int
  }

  enum JournalError: LocalizedError {
    case invalidMeeting, inactive, full, invalidAcknowledgement, damaged

    var errorDescription: String? {
      switch self {
      case .invalidMeeting: return "Invalid meeting journal identity."
      case .inactive: return "The meeting journal is not open."
      case .full: return "The local meeting journal is full. Open the app to save pending results."
      case .invalidAcknowledgement: return "Invalid meeting journal acknowledgement."
      case .damaged: return "The local meeting journal could not be read."
      }
    }
  }

  private let maximumBytes = 32 * 1024 * 1024
  private let maximumEventBytes = 512 * 1024
  private let manager = FileManager.default
  private var activeMeetingId: String?
  private typealias Entry = (sequence: Int, url: URL, size: Int)
  private var cachedFiles: (directory: URL, entries: [Entry])?

  func start(meetingId: String) throws {
    let directory = try folder(meetingId)
    if !manager.fileExists(atPath: directory.appendingPathComponent("metadata.json").path) {
      try save(Metadata(meetingId: meetingId, nextSequence: 1, acknowledgedSequence: 0), in: directory)
    }
    _ = try metadata(in: directory)
    activeMeetingId = meetingId
    cachedFiles = nil
    cachedFiles = (directory, try files(in: directory))
  }

  /// Call on the main actor, never from an audio render callback.
  func append(_ event: [String: Any]) throws -> Int {
    guard let meetingId = activeMeetingId else { throw JournalError.inactive }
    let directory = try folder(meetingId)
    var state = try metadata(in: directory)
    // The event file is committed before the metadata watermark. Recover a write interrupted between them.
    let pending = try files(in: directory)
    let sequence = max(state.nextSequence, pending.last.map { $0.sequence + 1 } ?? 1)
    let kind = event["kind"] as? String ?? "event"
    let envelope: [String: Any] = ["meetingId": meetingId, "sequence": sequence, "event": event]
    let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
    let superseded = try pending.filter { file in
      guard ["snapshot", "segment", "health", "speaker-tentative"].contains(kind),
        file.url.lastPathComponent.hasSuffix(".\(kind).json") else { return false }
      let previous = try JSONSerialization.jsonObject(with: Data(contentsOf: file.url)) as? [String: Any]
      guard let older = previous?["event"] as? [String: Any] else { throw JournalError.damaged }
      return canReplace(older, with: event)
    }
    let retained = pending.filter { candidate in !superseded.contains(where: { $0.sequence == candidate.sequence }) }
    let used = retained.reduce(0) { $0 + $1.size }
    guard data.count <= maximumEventBytes, used + data.count <= maximumBytes, retained.count < 8192 else {
      throw JournalError.full
    }
    let safeKind = kind.unicodeScalars.allSatisfy({ CharacterSet.letters.contains($0) || $0 == "-" })
      && kind.count < 32 ? kind : "event"
    let destination = directory.appendingPathComponent(String(format: "%020d", sequence) + ".\(safeKind).json")
    // Rebuild the index after a partial disk failure rather than reusing an uncertain sequence.
    cachedFiles = nil
    try write(data, to: destination)
    state.nextSequence = sequence + 1
    try save(state, in: directory)
    // Whole snapshots and replaced volatile spans carry their own replacement semantics.
    // Delete them only after their successor is durable, never just to meet the size limit.
    for file in superseded { try manager.removeItem(at: file.url) }
    cachedFiles = (directory, retained + [(sequence, destination, data.count)])
    return sequence
  }

  func read(meetingId: String, after: Int = 0, limit: Int = 64) throws -> [[String: Any]] {
    let directory = try folder(meetingId)
    let state = try metadata(in: directory)
    return try files(in: directory)
      .filter { $0.sequence > max(after, state.acknowledgedSequence) }
      .prefix(max(1, min(limit, 128)))
      .map { file in
        guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: file.url)) as? [String: Any],
          value["meetingId"] as? String == meetingId,
          value["sequence"] as? Int == file.sequence,
          value["event"] is [String: Any] else { throw JournalError.damaged }
        return value
      }
  }

  /// Acknowledge only after SQLite has durably applied all events through this sequence.
  func acknowledge(meetingId: String, through: Int) throws {
    let directory = try folder(meetingId)
    var state = try metadata(in: directory)
    let pending = try files(in: directory)
    let latest = max(state.nextSequence - 1, pending.last?.sequence ?? 0)
    guard through >= 0, through <= latest else { throw JournalError.invalidAcknowledgement }
    guard through > state.acknowledgedSequence else { return }
    state.acknowledgedSequence = through
    state.nextSequence = latest + 1
    // Persist the acknowledgement before deleting; a crash can leave extra files, never lost pending results.
    try save(state, in: directory)
    cachedFiles = nil
    for file in pending where file.sequence <= through { try manager.removeItem(at: file.url) }
    if activeMeetingId == meetingId {
      cachedFiles = (directory, pending.filter { $0.sequence > through })
    }
  }

  func meetings() throws -> [[String: Any]] {
    let root = try rootFolder()
    return try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])
      .compactMap { directory -> [String: Any]? in
        guard try directory.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { return nil }
        let state = try metadata(in: directory)
        let pending = try files(in: directory).filter { $0.sequence > state.acknowledgedSequence }
        guard !pending.isEmpty else { return nil }
        return ["meetingId": state.meetingId, "pendingCount": pending.count]
      }
  }

  func close() {
    activeMeetingId = nil
    cachedFiles = nil
  }

  /// Called only for an explicitly deleted, inactive meeting, never as a capacity eviction.
  func discard(meetingId: String) throws {
    guard meetingId != activeMeetingId else { throw JournalError.invalidAcknowledgement }
    let directory = try folder(meetingId)
    if manager.fileExists(atPath: directory.path) { try manager.removeItem(at: directory) }
    if cachedFiles?.directory == directory { cachedFiles = nil }
  }

  private func rootFolder() throws -> URL {
    let root = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true).appendingPathComponent("MeetingJournal", isDirectory: true)
    try manager.createDirectory(at: root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var protectedRoot = root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try protectedRoot.setResourceValues(values)
    return root
  }

  private func folder(_ meetingId: String) throws -> URL {
    guard !meetingId.isEmpty, meetingId.count <= 128,
      meetingId.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" })
      else { throw JournalError.invalidMeeting }
    let directory = try rootFolder().appendingPathComponent(meetingId, isDirectory: true)
    try manager.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    return directory
  }

  private func metadata(in directory: URL) throws -> Metadata {
    let value = try JSONDecoder().decode(Metadata.self,
      from: Data(contentsOf: directory.appendingPathComponent("metadata.json")))
    guard value.meetingId == directory.lastPathComponent, value.nextSequence > 0,
      value.acknowledgedSequence >= 0 else { throw JournalError.damaged }
    return value
  }

  private func save(_ state: Metadata, in directory: URL) throws {
    try write(JSONEncoder().encode(state), to: directory.appendingPathComponent("metadata.json"))
  }

  private func write(_ data: Data, to url: URL) throws {
    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.synchronize()
  }

  private func files(in directory: URL) throws -> [Entry] {
    if cachedFiles?.directory == directory, let entries = cachedFiles?.entries { return entries }
    return try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
      .compactMap { url -> Entry? in
        guard url.pathExtension == "json", let sequence = Int(url.lastPathComponent.components(separatedBy: ".")[0]),
          sequence > 0 else { return nil }
        return (sequence, url, try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
      }
      .sorted { $0.sequence < $1.sequence }
  }

  private func canReplace(_ older: [String: Any], with newer: [String: Any]) -> Bool {
    guard let kind = newer["kind"] as? String, older["kind"] as? String == kind else { return false }
    if kind == "snapshot" || kind == "health" || kind == "speaker-tentative" { return true }
    guard kind == "segment", older["final"] as? Bool == false,
      let oldStart = older["start"] as? Double, let oldEnd = older["end"] as? Double,
      let newStart = newer["start"] as? Double, let newEnd = newer["end"] as? Double else { return false }
    return oldStart == newStart || (oldEnd > newStart && oldStart < newEnd)
  }
}
