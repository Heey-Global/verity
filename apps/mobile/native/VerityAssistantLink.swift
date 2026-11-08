import Foundation
import Security

/// The iPhone's own line to Verity's conversation routes (docs/assistant.md), used
/// for the Apple Watch. A watch request usually arrives while the iPhone app is in
/// the background, where React Native does not run; waiting for JavaScript would
/// hold the words until the user opens the app. This sends them, and reads the
/// reply, from native code instead.
///
/// It only covers a direct, certificate-pinned connection to the server. Whatever
/// it cannot deliver stays in the watch inbox, and JavaScript sends it the next
/// time it runs, under the same request id, so the server takes it once.
final class VerityAssistantLink: @unchecked Sendable {
  static let shared = VerityAssistantLink()

  /// What JavaScript hands over while it is signed in to a directly reached server.
  struct Config: Codable, Equatable {
    let baseUrl: String
    let token: String
    let tlsPin: String
    /// The signed-in account; the watch's words only go to the account they were said in.
    let scope: String
  }

  enum Delivery {
    case sent
    /// Not now (offline, busy, not configured); JavaScript or a later attempt sends it.
    case later(String)
    /// The server refused it for good; retrying the same request cannot succeed.
    case refused(String)
  }

  private static let service = "build.verity.assistant-link"
  private let lock = NSLock()
  private var loaded = false
  private var stored: Config?
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    // A held read lasts up to `waitMs`; this leaves room for the answer on top.
    configuration.timeoutIntervalForRequest = 40
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration)
  }()

  private init() {}

  // MARK: Configuration

  /// Kept in the keychain, readable after first unlock, so a background wake
  /// while the phone is locked can still send. Nil forgets it (signed out, uplink).
  func configure(_ config: Config?) {
    lock.lock()
    defer { lock.unlock() }
    // Compare only with what is known to be stored: before the first read, a nil
    // here says nothing about the keychain, and a sign-out must always delete.
    if loaded, config != nil, stored == config { return }
    loaded = true
    stored = config
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: "config",
    ]
    SecItemDelete(query as CFDictionary)
    guard let config, let data = try? JSONEncoder().encode(config) else {
      try? FileManager.default.removeItem(at: Self.installMarker)
      return
    }
    // The keychain outlives an uninstall; this file does not. Without it, a
    // reinstalled app ignores the old item until JavaScript configures it again.
    FileManager.default.createFile(atPath: Self.installMarker.path, contents: Data())
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(item as CFDictionary, nil)
  }

  private static var installMarker: URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    return support.appendingPathComponent("verity-assistant-link")
  }

  var config: Config? {
    lock.lock()
    defer { lock.unlock() }
    if !loaded, !FileManager.default.fileExists(atPath: Self.installMarker.path) { return nil }
    if !loaded {
      loaded = true
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: Self.service,
        kSecAttrAccount as String: "config",
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
      ]
      var result: AnyObject?
      if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
        let data = result as? Data
      {
        stored = try? JSONDecoder().decode(Config.self, from: data)
      }
    }
    return stored
  }

  /// Whether words said under `scope` may be sent now. A capture without a scope
  /// (an interrupted recording) goes to the account signed in.
  func accepts(scope: String?) -> Bool {
    guard let config else { return false }
    return scope == nil || scope == config.scope
  }

  // MARK: Requests

  /// `projectId`: picked on older watch builds, offered to Verity as context.
  func sendMessage(requestId: String, text: String, projectId: String?) async -> Delivery {
    var body: [String: Any] = [
      "requestId": requestId, "text": text, "input": "voice", "device": "watch",
    ]
    if let projectId { body["projectId"] = projectId }
    return await deliver("/assistant/conversation/messages", body)
  }

  func sendAnswer(requestId: String, questionId: String, labels: [String]) async -> Delivery {
    await deliver(
      "/assistant/conversation/answers",
      ["requestId": requestId, "questionId": questionId, "labels": labels, "device": "watch"])
  }

  /// The conversation; with `after`, held by the server until it moves past that revision.
  func conversation(after: Int?, waitMs: Int) async throws -> [String: Any] {
    let query = after.map { "?after=\($0)&waitMs=\(waitMs)" } ?? ""
    let (status, body) = try await request("/assistant/conversation\(query)", method: "GET", body: nil)
    guard status == 200, let conversation = body as? [String: Any] else {
      throw LinkError.status(status)
    }
    return conversation
  }

  private func deliver(_ path: String, _ body: [String: Any]) async -> Delivery {
    do {
      let (status, response) = try await request(path, method: "POST", body: body)
      if status == 200 || status == 202 { return .sent }
      let payload = response as? [String: Any]
      let message = payload?["error"] as? String ?? "HTTP \(status)"
      let code = payload?["code"] as? String
      // Final: not this user's Verity, switched off, an invalid request, or an
      // answer to a question that is closed. Everything else (busy, restarting,
      // another delivery of this id under way, offline) is worth another try.
      if status == 400 || status == 403
        || (status == 409 && ["answered", "stale_question", "conflict", "disabled"].contains(code))
      {
        return .refused(message)
      }
      return .later(message)
    } catch {
      return .later(error.localizedDescription)
    }
  }

  private func request(_ path: String, method: String, body: [String: Any]?) async throws
    -> (Int, Any?)
  {
    guard let config, let origin = URL(string: config.baseUrl), origin.scheme == "https"
    else { throw LinkError.notConfigured }
    var base = config.baseUrl
    while base.hasSuffix("/") { base.removeLast() }
    guard let url = URL(string: base + path) else { throw LinkError.notConfigured }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(config.token)", forHTTPHeaderField: "authorization")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    // A fresh pin check per request, as the app's pinned transport does.
    let pin = try CertificatePinDelegate(pin: config.tlsPin, origin: origin)
    let (data, response) = try await session.data(for: request, delegate: pin)
    guard let http = response as? HTTPURLResponse else { throw LinkError.status(0) }
    return (http.statusCode, data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data))
  }

  enum LinkError: LocalizedError {
    case notConfigured
    case status(Int)
    var errorDescription: String? {
      switch self {
      case .notConfigured: return "No direct connection to Verity"
      case .status(let code): return "HTTP \(code)"
      }
    }
  }

  // MARK: Watch snapshot

  /// What the watch shows of a conversation (`VeritySnapshot` on the watch):
  /// state, the latest reply, the open question and how many approvals wait.
  /// Property lists have no null, so an absent value is an absent key.
  static func snapshot(_ conversation: [String: Any], scope: String?) -> [String: Any] {
    var snapshot: [String: Any] = [
      "availability": conversation["availability"] as? String ?? "unavailable",
      "state": conversation["state"] as? String ?? "idle",
      "revision": conversation["revision"] as? Int ?? 0,
      "approvals": (conversation["approvals"] as? [Any])?.count ?? 0,
    ]
    if let scope { snapshot["scope"] = scope }
    let items = conversation["items"] as? [[String: Any]] ?? []
    if let index = items.lastIndex(where: { $0["kind"] as? String == "reply" }),
      let reply = items[index]["text"] as? String
    {
      snapshot["replyId"] = items[index]["id"] as? String
      snapshot["replyMessageId"] = items[..<index].last(where: { $0["kind"] as? String == "message" })?["id"] as? String
      // The wrist shows the start; the full reply stays on the iPhone.
      snapshot["reply"] = String(reply.prefix(600))
    }
    if let question = conversation["question"] as? [String: Any],
      let id = question["id"] as? String,
      let options = question["options"] as? [[String: Any]]
    {
      var payload: [String: Any] = [
        "id": id, "options": options.compactMap { $0["label"] as? String },
        "multiSelect": question["multiSelect"] as? Bool ?? false,
      ]
      if let text = question["question"] as? String { payload["text"] = text }
      snapshot["question"] = payload
    }
    return snapshot
  }
}
