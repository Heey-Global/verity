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
    print("DATA diagnostic recorder tests passed")
  }
}
