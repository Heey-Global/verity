import Foundation

actor ResetWriter {
  private(set) var codes: [String] = []
  func send(_ frame: [String: String]) async throws { codes.append(frame["code"]!) }
}

// reset and didSendOpen are extracted from the production tunnel. Only the
// stream storage and socket boundary are substituted.
@main
struct OpenResetCheck {
  static func main() async {
    let tunnel = ResetTunnel()
    let stream = tunnel.insert("late")
    await tunnel.reset("late", code: "upstream_error")
    let beforeOpen = await tunnel.writer.codes
    precondition(beforeOpen.isEmpty, "reset overtook open")
    tunnel.didSendOpen(stream, id: "late")
    for _ in 0..<1000 {
      if await tunnel.writer.codes.count == 1 { break }
      try? await Task.sleep(nanoseconds: 1_000_000)
    }
    guard await tunnel.writer.codes == ["upstream_error"] else {
      print("deferred-reset-missing")
      exit(1)
    }
    let opened = tunnel.insert("opened")
    tunnel.didSendOpen(opened, id: "opened")
    await tunnel.reset("opened", code: "timeout")
    for _ in 0..<1000 {
      if await tunnel.writer.codes.count == 2 { break }
      try? await Task.sleep(nanoseconds: 1_000_000)
    }
    let codes = await tunnel.writer.codes
    precondition(codes == ["upstream_error", "timeout"], "opened stream reset missing")
    print("open-reset-order-preserved")
  }

}
