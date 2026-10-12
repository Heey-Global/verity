import Foundation

@main
struct DiagnosticsTest {
  static func main() throws {
    var time: TimeInterval = 10
    let utc = Date(timeIntervalSince1970: 1_791_472_991)
    let recorder = RemoteDataDiagnostics(clock: { time }, utc: { utc })
    precondition(recorder.export() == nil)
    recorder.record(.failure, error: NSError(domain: "secret", code: 1))
    recorder.bind(sessionHash: "c1448f52fd7bef90")
    recorder.enable(startedLate: false, delegateAvailable: true)
    recorder.enable(startedLate: true, delegateAvailable: false)
    recorder.record(.cancelRequested, cause: .appStop)
    time += 0.1
    recorder.record(.failure, cause: .readFailure, error: NSError(domain: "private-domain", code: -1005,
      userInfo: [NSLocalizedDescriptionKey: "https://private?ticket=secret", "payload": "SECRET"]))
    let exported = recorder.export()!
    precondition(!exported.contains("private") && !exported.contains("SECRET") && !exported.contains("ticket"))
    let initial = try JSONSerialization.jsonObject(with: Data(exported.utf8)) as! [String: Any]
    let entries = initial["events"] as! [[String: Any]]
    precondition(entries.map { $0["event"] as! String } == ["capture_started", "cancel_requested", "failure"])
    precondition(entries[2]["errorDomain"] as? String == "OtherErrorDomain")
    precondition(initial["startedLate"] as? Bool == false)
    for _ in 0..<200 { recorder.record(.networkPath, path: .satisfied) }
    time += 121
    recorder.record(.socketClose, closeCode: 1001)
    let final = try JSONSerialization.jsonObject(with: Data(recorder.export()!.utf8)) as! [String: Any]
    let bounded = final["events"] as! [[String: Any]]
    precondition(bounded.count == RemoteDataDiagnostics.capacity)
    precondition(final["dropped"] as? Int == 75)
    precondition(final["expired"] as? Bool == true)
    precondition(bounded[1]["event"] as? String == "cancel_requested")
    let next = RemoteDataDiagnostics()
    next.bind(sessionHash: "https://secret")
    next.enable(startedLate: true, delegateAvailable: false)
    next.record(.failure, cause: .readFailure, error: NSError(domain: NSURLErrorDomain, code: -1005))
    next.record(.cancelRequested, cause: .readFailure)
    precondition(next.generation != recorder.generation)
    let second = try JSONSerialization.jsonObject(with: Data(next.export()!.utf8)) as! [String: Any]
    precondition(second["sessionHash"] == nil)
    let secondEvents = second["events"] as! [[String: Any]]
    precondition(secondEvents[1]["event"] as? String == "failure")
    precondition(secondEvents[2]["event"] as? String == "cancel_requested")
    next.disable()
    let before = next.export()
    next.record(.socketClose, closeCode: 1000)
    precondition(next.export() == before)
    // Exhaustion and stall replacements inherit a single test window.
    time = 1000
    let window = RemoteDataCaptureWindow(clock: { time })
    precondition(window.remaining == 0)
    precondition(window.begin(existingIsActive: false) {
      preconditionFailure("An exhausted tunnel must not consume the selected capture")
    })
    let firstAttempt = RemoteDataDiagnostics(clock: { time })
    firstAttempt.enable(startedLate: false, delegateAvailable: true, duration: window.remaining)
    time += 10
    let stallReplacement = RemoteDataDiagnostics(clock: { time })
    stallReplacement.enable(startedLate: false, delegateAvailable: true, duration: window.remaining)
    let replacement = try JSONSerialization.jsonObject(with: Data(stallReplacement.export()!.utf8)) as! [String: Any]
    precondition(replacement["captureLimitMs"] as? Int == 110_000)
    precondition(firstAttempt.generation != stallReplacement.generation)
    time += 111
    precondition(window.remaining == 0)
    for attempt in [firstAttempt, stallReplacement] {
      let state = try JSONSerialization.jsonObject(with: Data(attempt.export()!.utf8)) as! [String: Any]
      precondition(state["expired"] as? Bool == true)
    }
    window.clear()
    precondition(window.remaining == 0)
    precondition(!window.begin(existingIsActive: true) { false })
    precondition(window.remaining == 0)
    // A replacement must not make the old stream account depend on its live tunnel.
    time = 2000
    let streamRecorder = RemoteDataDiagnostics(clock: { time })
    let id = "0123456789ABCDEF0123456789ABCDEF"
    func stream(_ id: String, sent: Int = 0,
      endedBy: RemoteDataDiagnostics.End = .open) -> RemoteDataDiagnostics.StreamSnapshot {
      .init(streamId: id, proxy: .socks, endedBy: endedBy, sentBytes: sent,
        receivedBytes: 2507, deliveredBytes: 2507, outgoingFrames: 1, incomingFrames: 1,
        outgoingTLSRecords: [22], incomingTLSRecords: [22, 20, 23], firstHandshake: "2")
    }
    streamRecorder.retainStream(stream(id))
    precondition(streamRecorder.export() == nil)
    streamRecorder.enable(startedLate: true, delegateAvailable: true)
    streamRecorder.retainStream(stream(id))
    streamRecorder.record(.streamOpened, streamId: id)
    time += 1
    streamRecorder.retainStream(stream(id, sent: 1526))
    streamRecorder.record(.streamSendCompleted, streamId: id)
    streamRecorder.record(.streamStalled, streamId: id)
    for index in 1...16 {
      streamRecorder.retainStream(stream(String(format: "%032X", index)))
    }
    let streamState = try JSONSerialization.jsonObject(with: Data(streamRecorder.export()!.utf8)) as! [String: Any]
    let retainedStreams = streamState["streams"] as! [[String: Any]]
    precondition(retainedStreams.count == RemoteDataDiagnostics.streamCapacity)
    precondition(retainedStreams[0]["streamId"] as? String == id)
    precondition(retainedStreams[0]["sentBytes"] as? Int == 1526)
    precondition(retainedStreams[0]["incomingTLSRecords"] as? [Int] == [22, 20, 23])
    precondition(streamState["streamUpdatesDropped"] as? Int == 1)
    let streamEvents = streamState["events"] as! [[String: Any]]
    precondition(streamEvents[2]["event"] as? String == "stream_send_completed")
    precondition(streamEvents[3]["event"] as? String == "stream_stalled")
    // An idle remote half must not leave a local EOF reported as open at expiry.
    streamRecorder.retainStream(stream(id, sent: 1526, endedBy: .local))
    // Remote EOF must survive expiry even while local delivery remains blocked.
    let remoteId = String(format: "%032X", 1)
    streamRecorder.retainStream(stream(remoteId, endedBy: .remote))
    time += 121
    streamRecorder.retainStream(stream(id, sent: 9999))
    let expiredState = try JSONSerialization.jsonObject(with: Data(streamRecorder.export()!.utf8)) as! [String: Any]
    precondition((expiredState["streams"] as! [[String: Any]])[0]["sentBytes"] as? Int == 1526)
    precondition((expiredState["streams"] as! [[String: Any]])[0]["endedBy"] as? String == "local")
    precondition((expiredState["streams"] as! [[String: Any]])[1]["endedBy"] as? String == "remote")
    let invalidRecorder = RemoteDataDiagnostics()
    invalidRecorder.enable(startedLate: false, delegateAvailable: true)
    invalidRecorder.retainStream(stream("private-url?ticket=secret"))
    invalidRecorder.disable()
    invalidRecorder.retainStream(stream(id))
    let invalidState = try JSONSerialization.jsonObject(with: Data(invalidRecorder.export()!.utf8)) as! [String: Any]
    precondition((invalidState["streams"] as! [[String: Any]]).isEmpty)
    precondition(!invalidRecorder.export()!.contains("secret"))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("recording.json")
    let store = RemoteDataRecordingStore(file: file)
    for _ in 0..<4 {
      let persistent = RemoteDataDiagnostics()
      persistent.snapshotSink = { [weak persistent] in
        guard let persistent else { return }
        store.schedule(generation: persistent.generation) { persistent.export() }
      }
      persistent.enable(startedLate: false, delegateAvailable: true)
      persistent.record(.failure, error: NSError(domain: "private-secret", code: -1,
        userInfo: [NSLocalizedDescriptionKey: "ticket=SECRET"]))
    }
    store.flush()
    let restored = RemoteDataRecordingStore(file: file).snapshots()
    precondition(restored.count == 3)
    for value in restored {
      let object = try JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any]
      precondition(object["expired"] as? Bool == true)
    }
    var persistenceClock: TimeInterval = 0
    let expiring = RemoteDataDiagnostics(clock: { persistenceClock })
    expiring.snapshotSink = { [weak expiring] in
      guard let expiring else { return }
      store.schedule(generation: expiring.generation) { expiring.export() }
    }
    expiring.enable(startedLate: false, delegateAvailable: true)
    persistenceClock = RemoteDataDiagnostics.duration + 1
    store.schedule(generation: expiring.generation) { expiring.export() }
    store.flush()
    let expiredSnapshot = try JSONSerialization.jsonObject(with: Data(store.snapshots().last!.utf8)) as! [String: Any]
    precondition(expiredSnapshot["expired"] as? Bool == true)
    precondition(restored.allSatisfy { !$0.contains("SECRET") && !$0.contains("private-secret") })
    precondition(restored.allSatisfy { $0.contains("failure") })
    // Restart restores evidence only; capture intent never persists.
    precondition(RemoteDataCaptureWindow().remaining == 0)
    try Data("incomplete{".utf8).write(to: file)
    precondition(RemoteDataRecordingStore(file: file).snapshots().isEmpty)
    try Data(repeating: 65, count: RemoteDataRecordingStore.maximumBytes + 1).write(to: file)
    precondition(RemoteDataRecordingStore(file: file).snapshots().isEmpty)
    print("DATA diagnostic recorder tests passed")
  }
}
