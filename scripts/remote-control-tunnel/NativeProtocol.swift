import Foundation

private enum NativeProtocolCheckError: Error {
  case acceptedInvalidFrame(String)
  case decodedValueMismatch
}

// Exercise the production decoder with JSONSerialization's actual bridging, including CFBoolean.
@available(macOS 14.0, iOS 17.0, *)
func runNativeProtocolChecks() throws {
  func decode(_ json: String) throws -> (sequence: Int, data: Data) {
    let frame = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    return try RemoteAppTunnel.decodeDataFrame(frame)
  }
  for sequence in ["0", "1", "1.0", "1e0", "9007199254740991"] {
    let result = try decode("{\"type\":\"stream.data\",\"streamId\":\"test_1\",\"seq\":\(sequence),\"payload\":\"AAECAw==\"}")
    guard result.data == Data([0, 1, 2, 3]), result.sequence == Int(Double(sequence)!)
    else { throw NativeProtocolCheckError.decodedValueMismatch }
  }
  var invalid = [String]()
  for sequence in ["true", "false", "0.5", "-1", "9007199254740992", "1e100", "null", "\"0\""] {
    invalid.append("{\"type\":\"stream.data\",\"streamId\":\"test\",\"seq\":\(sequence),\"payload\":\"\"}")
  }
  for payload in ["Zg", "Zh==", "Zg==\n", "====", "!"] {
    let frame: [String: Any] = ["type": "stream.data", "streamId": "test", "seq": 0, "payload": payload]
    invalid.append(String(data: try JSONSerialization.data(withJSONObject: frame), encoding: .utf8)!)
  }
  invalid.append("{\"type\":\"stream.data\",\"streamId\":\"test\",\"seq\":0,\"payload\":\"\",\"extra\":true}")
  invalid.append("{\"type\":\"stream.data\",\"streamId\":\"invalid.id\",\"seq\":0,\"payload\":\"\"}")
  for (index, json) in invalid.enumerated() {
    do { _ = try decode(json) }
    catch { continue }
    throw NativeProtocolCheckError.acceptedInvalidFrame("case \(index)")
  }
  let boundary = Data(repeating: 0xA5, count: 64 * 1024)
  var frame: [String: Any] = ["type": "stream.data", "streamId": "boundary", "seq": 0,
    "payload": boundary.base64EncodedString()]
  guard try RemoteAppTunnel.decodeDataFrame(frame).data == boundary
  else { throw NativeProtocolCheckError.decodedValueMismatch }
  frame["payload"] = (boundary + Data([0])).base64EncodedString()
  do { _ = try RemoteAppTunnel.decodeDataFrame(frame) }
  catch { return }
  throw NativeProtocolCheckError.acceptedInvalidFrame("oversize")
}
