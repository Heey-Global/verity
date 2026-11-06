import AVFoundation
import CryptoKit
import Foundation
import Speech

/// An opt-in, on-device recovery spool. Its serial writer never blocks microphone delivery.
final class LiveMeetingAudioBuffer: @unchecked Sendable {
  private struct Segment: Codable {
    let id: String
    let start: Double
    var end: Double
  }

  private struct Manifest: Codable {
    let meetingId: String
    let locale: String
    var confirmedThrough: Double
    var segments: [Segment]
  }

  private struct Packet: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    let at: Double
  }

  private let queue = DispatchQueue(label: "build.verity.meeting-audio-buffer", qos: .utility)
  private let slots = DispatchSemaphore(value: 32)
  private let overflowLock = NSLock()
  private var overflowReported = false
  private let directory: URL
  private let onFailure: @Sendable (String) -> Void
  private var manifest: Manifest
  private var file: AVAudioFile?
  private var failed = false
  private var bytes: Int64 = 0
  private static let byteLimit: Int64 = 128 * 1024 * 1024
  private static let segmentSeconds: Double = 30

  init(meetingId: String, enabled: Bool, locale: String = "de-DE",
       onFailure: @escaping @Sendable (String) -> Void) throws {
    directory = try Self.directory(meetingId)
    self.onFailure = onFailure
    manifest = Manifest(meetingId: meetingId, locale: locale, confirmedThrough: 0, segments: [])
    failed = !enabled
    guard enabled else { return }
    // An existing spool belongs to a previous process and must be recovered or discarded first.
    guard !FileManager.default.fileExists(atPath: directory.path) else {
      throw BufferError.unavailable("Recover or discard the saved audio before recording this meeting again.")
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var resource = URLResourceValues()
    resource.isExcludedFromBackup = true
    var directory = directory
    try directory.setResourceValues(resource)
    try persist()
  }

  /// The caller passes the immutable copy already made for microphone consumers.
  func append(_ buffer: AVAudioPCMBuffer, at: Double) {
    guard slots.wait(timeout: .now()) == .success else {
      overflowLock.lock()
      let firstOverflow = !overflowReported
      overflowReported = true
      overflowLock.unlock()
      if firstOverflow {
        queue.async { self.fail("The audio safety buffer fell behind; recording continues without its protection.") }
      }
      return
    }
    let packet = Packet(buffer: buffer, at: at)
    queue.async {
      defer { self.slots.signal() }
      guard !self.failed else { return }
      do { try self.write(packet) }
      catch { self.fail("Audio safety buffer stopped: \(error.localizedDescription)") }
    }
  }

  /// Call only after the corresponding final transcript has been durably journaled.
  func confirm(through: Double) {
    queue.async {
      guard !self.failed, through.isFinite, through >= self.manifest.confirmedThrough else { return }
      self.manifest.confirmedThrough = through
      do {
        // Keep the open file: recognition can finalize before the next audio buffer arrives.
        let openId = self.file == nil ? nil : self.manifest.segments.last?.id
        let expired = self.manifest.segments.filter { $0.id != openId && $0.end <= through }
        // Persist the transcript boundary, but keep file identities until deletion succeeds.
        try self.persist()
        for segment in expired { try self.remove(segment) }
        self.manifest.segments.removeAll { segment in expired.contains { $0.id == segment.id } }
        try self.persist()
      } catch { self.fail("Could not update the audio safety buffer: \(error.localizedDescription)") }
    }
  }

  func finish() {
    queue.async {
      self.file = nil
      do {
        let expired = self.manifest.segments.filter { $0.end <= self.manifest.confirmedThrough }
        // Persist the transcript boundary, but keep file identities until deletion succeeds.
        try self.persist()
        for segment in expired { try self.remove(segment) }
        self.manifest.segments.removeAll { segment in expired.contains { $0.id == segment.id } }
        try self.persist()
        if self.manifest.segments.isEmpty { try FileManager.default.removeItem(at: self.directory) }
      } catch { self.fail("Could not finalize the audio safety buffer: \(error.localizedDescription)") }
    }
  }

  /// End/recovery callers await this after stopping capture before touching its retained files.
  func flush() async {
    await withCheckedContinuation { continuation in
      queue.async { continuation.resume() }
    }
  }

  private func write(_ packet: Packet) throws {
    let duration = Double(packet.buffer.frameLength) / packet.buffer.format.sampleRate
    let packetBytes = Int64(packet.buffer.frameLength) * Int64(packet.buffer.format.channelCount) * 4
    guard packet.at.isFinite, duration.isFinite, duration > 0 else { return }
    guard bytes + packetBytes <= Self.byteLimit else {
      throw BufferError.unavailable("The 128 MB recovery limit was reached; saved audio was retained.")
    }
    if file == nil || packet.at - (manifest.segments.last?.start ?? packet.at) >= Self.segmentSeconds
      || abs(packet.at - (manifest.segments.last?.end ?? packet.at)) > 0.25
      || file?.processingFormat != packet.buffer.format {
      file = nil
      let segment = Segment(id: UUID().uuidString, start: packet.at, end: packet.at)
      let url = directory.appendingPathComponent(segment.id).appendingPathExtension("caf")
      file = try AVAudioFile(forWriting: url, settings: packet.buffer.format.settings,
        commonFormat: packet.buffer.format.commonFormat, interleaved: packet.buffer.format.isInterleaved)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
      manifest.segments.append(segment)
      // Persist the file identity before writing: after a crash its frame count supplies the end.
      try persist()
    }
    try file?.write(from: packet.buffer)
    bytes += packetBytes
    manifest.segments[manifest.segments.count - 1].end = packet.at + duration
  }

  private func fail(_ message: String) {
    guard !failed else { return }
    failed = true
    file = nil
    try? persist()
    onFailure(message)
  }

  private func remove(_ segment: Segment) throws {
    let url = directory.appendingPathComponent(segment.id).appendingPathExtension("caf")
    if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize {
      bytes = max(0, bytes - Int64(size))
    }
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
  }

  private func persist() throws {
    try JSONEncoder().encode(manifest).write(to: directory.appendingPathComponent("manifest.json"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  private static func root() throws -> URL {
    try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true).appendingPathComponent("MeetingAudioRecovery", isDirectory: true)
  }

  private static func directory(_ meetingId: String) throws -> URL {
    let name = SHA256.hash(data: Data(meetingId.utf8)).map { String(format: "%02x", $0) }.joined()
    return try root().appendingPathComponent(name, isDirectory: true)
  }

  private static func load(_ directory: URL) throws -> Manifest {
    try JSONDecoder().decode(Manifest.self,
      from: Data(contentsOf: directory.appendingPathComponent("manifest.json")))
  }

  static func pending() throws -> [[String: Any]] {
    let root = try root()
    guard FileManager.default.fileExists(atPath: root.path) else { return [] }
    return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
      .compactMap { directory in
        guard let manifest = try? load(directory), !manifest.segments.isEmpty else { return nil }
        let duration = manifest.segments.reduce(0.0) { total, segment in
          let url = directory.appendingPathComponent(segment.id).appendingPathExtension("caf")
          guard let audio = try? AVAudioFile(forReading: url) else { return total }
          return total + max(0, segment.start + Double(audio.length) / audio.processingFormat.sampleRate
            - max(segment.start, manifest.confirmedThrough))
        }
        return ["meetingId": manifest.meetingId, "locale": manifest.locale,
          "segments": manifest.segments.count, "duration": duration]
      }
  }

  static func discard(meetingId: String) throws {
    let directory = try directory(meetingId)
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }

  /// The UI explicitly identifies Apple Speech as the local recovery engine.
  /// Files are retained until the caller durably saves results and acknowledges their identities.
  @available(iOS 26.0, *)
  static func recover(meetingId: String, confirmedThrough: Double = 0) async throws -> [[String: Any]] {
    let directory = try directory(meetingId)
    let manifest = try load(directory)
    guard SpeechTranscriber.isAvailable,
      let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: manifest.locale))
    else { throw BufferError.unavailable("Apple Speech recovery is unavailable for this meeting's language.") }
    var recovered: [[String: Any]] = []
    for segment in manifest.segments {
      // Deletion may have completed before its manifest update. Treat that retry as already consumed.
      let sourceURL = directory.appendingPathComponent(segment.id).appendingPathExtension("caf")
      if !FileManager.default.fileExists(atPath: sourceURL.path) {
        recovered.append(["id": segment.id, "text": "", "start": segment.start, "end": segment.end])
        continue
      }
      let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [],
        reportingOptions: [], attributeOptions: [.audioTimeRange])
      guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
        throw BufferError.unavailable("Download the meeting language in Apple Speech before recovering audio.")
      }
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      let collect = Task {
        var parts: [String] = []
        for try await result in transcriber.results {
          parts.append(String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " ")
      }
      let temporary = directory.appendingPathComponent("recovery-\(segment.id).caf")
      defer { try? FileManager.default.removeItem(at: temporary) }
      do {
        let source = try AVAudioFile(forReading:
          directory.appendingPathComponent(segment.id).appendingPathExtension("caf"))
        let endSeconds = segment.start + Double(source.length) / source.processingFormat.sampleRate
        let recoveryStart = max(segment.start, max(manifest.confirmedThrough, confirmedThrough))
        guard recoveryStart < endSeconds else {
          await analyzer.cancelAndFinishNow()
          collect.cancel()
          recovered.append(["id": segment.id, "text": "", "start": recoveryStart, "end": endSeconds])
          continue
        }
        // Cut at the durable boundary before recognition, avoiding duplicate words even when
        // SpeechAnalyzer groups a whole phrase into one attributed range.
        source.framePosition = AVAudioFramePosition(
          max(0, recoveryStart - segment.start) * source.processingFormat.sampleRate)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: source.processingFormat, frameCapacity: 4096)
        else { throw BufferError.unavailable("Could not prepare the saved audio for recovery.") }
        var writer: AVAudioFile? = try AVAudioFile(forWriting: temporary,
          settings: source.processingFormat.settings,
          commonFormat: source.processingFormat.commonFormat,
          interleaved: source.processingFormat.isInterleaved)
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: temporary.path)
        while source.framePosition < source.length {
          try source.read(into: buffer)
          guard buffer.frameLength > 0 else { break }
          try writer?.write(from: buffer)
        }
        writer = nil
        let file = try AVAudioFile(forReading: temporary)
        if let end = try await analyzer.analyzeSequence(from: file) {
          try await analyzer.finalizeAndFinish(through: end)
        } else { await analyzer.cancelAndFinishNow() }
        let text = try await collect.value
        recovered.append(["id": segment.id, "text": text,
          "start": recoveryStart, "end": endSeconds])
      } catch {
        await analyzer.cancelAndFinishNow()
        collect.cancel()
        throw error
      }
    }
    return recovered
  }

  static func acknowledgeRecovery(meetingId: String, segmentIds: [String]) throws {
    let directory = try directory(meetingId)
    var manifest = try load(directory)
    let acknowledged = manifest.segments.filter { segmentIds.contains($0.id) }
    // Keep the manifest as retry bookkeeping until every acknowledged file is gone.
    for segment in acknowledged {
      let url = directory.appendingPathComponent(segment.id).appendingPathExtension("caf")
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
    }
    manifest.segments.removeAll { segmentIds.contains($0.id) }
    if manifest.segments.isEmpty { try FileManager.default.removeItem(at: directory) }
    else {
      try JSONEncoder().encode(manifest).write(to: directory.appendingPathComponent("manifest.json"),
        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }

  private enum BufferError: LocalizedError {
    case unavailable(String)
    var errorDescription: String? { if case .unavailable(let message) = self { message } else { nil } }
  }
}
