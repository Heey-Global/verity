internal import ExpoModulesCore
import UniformTypeIdentifiers
import UIKit

/// Temporary copies handed to a drop destination are reaped this long after the
/// drag that produced them. The destination copies the bytes out promptly, so
/// this only has to outlive one drop, not one session.
private let dragCopyLifetime: TimeInterval = 600

/// One draggable file. The payload is deliberately a server URL and not bytes:
/// a drag can start on any row at any time, and materializing even a moderate
/// file up front would stall the gesture. See `VerityDragZoneView`.
struct VerityDragFile: Record {
  @Field var url: String = ""
  @Field var fileName: String = "file"
  @Field var mimeType: String = "application/octet-stream"
}

class VerityDragZone: Module {
  public func definition() -> ModuleDefinition {
    View(VerityDragZoneView.self) {
      Events("onDragBegin", "onDragEnd", "onModifiers")

      Prop("enabled") { (view: VerityDragZoneView, enabled: Bool) in
        view.dragEnabled = enabled
      }

      Prop("items") { (view: VerityDragZoneView, items: [VerityDragFile]) in
        view.files = items
      }

      // Sent as the `authorization` header on the promise's download. Held only
      // in memory for the lifetime of the view, never written to disk or logged.
      Prop("authorization") { (view: VerityDragZoneView, authorization: String) in
        view.authorization = authorization
      }
    }
  }
}

/// Drag source for session files. Wraps a single file-browser row; the `items`
/// prop carries whatever that row should drag — just itself, or the whole
/// selection when the row is part of one (the JS side decides, mirroring
/// Finder).
///
/// Each item is registered as a *file promise* rather than a loaded file: the
/// download only runs once a drop is actually accepted, so dragging a 200 MB
/// build artifact costs nothing unless it lands somewhere. On an Apple silicon
/// Mac the drop destination is usually Finder; on iPadOS it is another app.
class VerityDragZoneView: ExpoView, UIDragInteractionDelegate {
  let onDragBegin = EventDispatcher()
  let onDragEnd = EventDispatcher()
  let onModifiers = EventDispatcher()
  var dragEnabled = true
  var files: [VerityDragFile] = []
  var authorization = ""

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    addInteraction(UIDragInteraction(delegate: self))
    let probe = ModifierProbe()
    // Reported on every touch down, including the empty set — the JS side keeps
    // one shared "modifiers held" value for the whole list, so a row that stayed
    // silent because ITS last report matched would leave another row's shift
    // standing. Two booleans per press is well inside the noise of a tap.
    probe.onFlags = { [weak self] flags in
      self?.onModifiers([
        "shift": flags.contains(.shift),
        "command": flags.contains(.command),
      ])
    }
    addGestureRecognizer(probe)
  }

  func dragInteraction(
    _ interaction: UIDragInteraction,
    itemsForBeginning session: UIDragSession
  ) -> [UIDragItem] {
    guard dragEnabled else { return [] }
    return files.compactMap(dragItem(for:))
  }

  func dragInteraction(_ interaction: UIDragInteraction, sessionWillBegin session: UIDragSession) {
    // Purging here rather than on a timer keeps it off any path that could race
    // a destination still copying out of a directory from this same drag.
    Self.purgeStaleCopies()
    onDragBegin(["count": session.items.count])
  }

  func dragInteraction(
    _ interaction: UIDragInteraction,
    session: UIDragSession,
    willEndWith operation: UIDropOperation
  ) {
    onDragEnd(["delivered": operation == .copy || operation == .move])
  }

  private func dragItem(for file: VerityDragFile) -> UIDragItem? {
    guard let source = URL(string: file.url), !file.fileName.isEmpty else { return nil }
    let type = UTType(mimeType: file.mimeType) ?? .data
    let provider = NSItemProvider()
    provider.suggestedName = file.fileName
    provider.registerFileRepresentation(
      forTypeIdentifier: type.identifier,
      // `.openInPlace` would hand the destination our temporary copy's URL, which
      // is reaped out from under it. Copying is what Finder expects from a
      // download anyway.
      fileOptions: [],
      visibility: .all
    ) { [authorization] completion in
      Self.download(
        from: source,
        fileName: file.fileName,
        authorization: authorization,
        completion: completion
      )
    }
    return UIDragItem(itemProvider: provider)
  }

  /// Fetch the file into a uniquely-named temporary directory and hand the drop
  /// destination that URL. `coordinated: false` says the URL is not under file
  /// coordination — the destination copies the bytes itself, and the promise API
  /// reports no completion we could delete against, so the copy is reaped by
  /// {@link purgeStaleCopies} once it has outlived any plausible drop.
  private static func download(
    from source: URL,
    fileName: String,
    authorization: String,
    completion: @escaping (URL?, Bool, Error?) -> Void
  ) -> Progress? {
    var request = URLRequest(url: source)
    if !authorization.isEmpty {
      request.setValue(authorization, forHTTPHeaderField: "authorization")
    }
    let task = URLSession.shared.downloadTask(with: request) { location, response, error in
      guard let location else {
        completion(nil, false, error ?? VerityDragError.unreadable(fileName))
        return
      }
      if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
        try? FileManager.default.removeItem(at: location)
        completion(nil, false, VerityDragError.server(fileName, http.statusCode))
        return
      }
      do {
        let directory = copyRoot().appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // A drop destination takes the saved file's name from this URL, so the
        // temporary copy has to carry the real name — hence a directory per
        // drag instead of a UUID-prefixed file name.
        let destination = directory.appendingPathComponent(sanitized(fileName))
        try FileManager.default.moveItem(at: location, to: destination)
        completion(destination, false, nil)
        schedulePurge()
      } catch {
        try? FileManager.default.removeItem(at: location)
        completion(nil, false, error)
      }
    }
    task.resume()
    return task.progress
  }

  private static func copyRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("VerityDrags", isDirectory: true)
  }

  /// Reap this drag's own copy once it is older than the lifetime. Without it a
  /// session's last drag would leave its file behind until the next drag — which
  /// may never come. The purge only removes entries past the cutoff, so it can
  /// never pull a file out from under a destination that is still copying.
  private static func schedulePurge() {
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + dragCopyLifetime + 1) {
      purgeStaleCopies()
    }
  }

  private static func purgeStaleCopies() {
    let root = copyRoot()
    let manager = FileManager.default
    guard
      let entries = try? manager.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: [.creationDateKey],
        options: [.skipsHiddenFiles]
      )
    else { return }
    let cutoff = Date().addingTimeInterval(-dragCopyLifetime)
    for entry in entries {
      let created = try? entry.resourceValues(forKeys: [.creationDateKey]).creationDate
      guard let created, created < cutoff else { continue }
      try? manager.removeItem(at: entry)
    }
  }

  private static func sanitized(_ fileName: String) -> String {
    let name = URL(fileURLWithPath: fileName).lastPathComponent
      .components(separatedBy: .controlCharacters).joined()
    return name.isEmpty ? "file" : name
  }
}

/// Reports which modifier keys were held at touch down, so a row can tell a
/// plain tap from a command- or shift-click. React Native does not surface them:
/// its W3C pointer events carry `shiftKey`/`metaKey`, but iOS leaves that
/// dispatch off by default (`RCTDispatchW3CPointerEvents`), and the classic
/// touch path has no modifier fields at all.
///
/// A gesture recognizer rather than a `touchesBegan` override, because a
/// recognizer sees every touch in its view's subtree whatever the touch actually
/// hit-tests to — and the row's own pressable content sits above this view. It
/// never recognizes: failing straight away in `touchesBegan` keeps it out of
/// everything else's way, including React Native's touch handling and the drag
/// interaction on this same view. Reporting rather than handling the click is
/// deliberate — if the report ever arrives late, the row falls back to behaving
/// like a plain tap instead of firing twice.
private final class ModifierProbe: UIGestureRecognizer {
  var onFlags: ((UIKeyModifierFlags) -> Void)?

  override init(target: Any?, action: Selector?) {
    super.init(target: target, action: action)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
  }

  convenience init() {
    self.init(target: nil, action: nil)
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    onFlags?(event.modifierFlags)
    state = .failed
  }
}

private enum VerityDragError: LocalizedError {
  case unreadable(String)
  case server(String, Int)

  var errorDescription: String? {
    switch self {
    case .unreadable(let name):
      return "Could not download \"\(name)\"."
    case .server(let name, let status):
      return "Could not download \"\(name)\" (HTTP \(status))."
    }
  }
}
