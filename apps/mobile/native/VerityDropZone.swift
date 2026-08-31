internal import ExpoModulesCore
import UniformTypeIdentifiers
import UIKit

/// The composer's ceiling: a dropped attachment travels base64-encoded inside a
/// turn, so it is bound by the server's MAX_ATTACHMENT_BASE64_LEN. Surfaces that
/// stream a drop straight to disk — the session file browser — raise it via the
/// `maxFileBytes` prop.
private let defaultMaximumDroppedFileBytes = 5_250_000
private let maximumDroppedFileNameBytes = 160

class VerityDropZone: Module {
  public func definition() -> ModuleDefinition {
    View(VerityDropZoneView.self) {
      Events("onDropActive", "onDropFiles")

      Prop("enabled") { (view: VerityDropZoneView, enabled: Bool) in
        view.dropEnabled = enabled
      }

      Prop("maxFiles") { (view: VerityDropZoneView, maxFiles: Int) in
        view.maxFiles = max(0, maxFiles)
      }

      Prop("maxFileBytes") { (view: VerityDropZoneView, maxFileBytes: Int) in
        view.maxFileBytes = maxFileBytes > 0 ? maxFileBytes : defaultMaximumDroppedFileBytes
      }

      Prop("maxTotalBytes") { (view: VerityDropZoneView, maxTotalBytes: Int) in
        view.maxTotalBytes = max(0, maxTotalBytes)
      }
    }
  }
}

/// Bytes one drop may still copy into the temporary directory. Claims are never
/// returned: a file that fails after claiming just leaves the rest of the drop a
/// smaller budget, which is the safe direction to be wrong in.
private final class DropBudget {
  private let lock = NSLock()
  private var remaining: Int

  init(limit: Int) {
    remaining = limit > 0 ? limit : Int.max
  }

  func claim(_ bytes: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard bytes <= remaining else { return false }
    remaining -= bytes
    return true
  }
}

class VerityDropZoneView: ExpoView, UIDropInteractionDelegate {
  let onDropActive = EventDispatcher()
  let onDropFiles = EventDispatcher()
  var dropEnabled = true
  var maxFiles = 0
  var maxFileBytes = defaultMaximumDroppedFileBytes
  /// Ceiling across one drop, 0 for none. Files are copied concurrently before
  /// JS gets to upload them one by one, so without this a drop of `maxFiles`
  /// large files would briefly need `maxFiles * maxFileBytes` of scratch space.
  var maxTotalBytes = 0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    addInteraction(UIDropInteraction(delegate: self))
  }

  func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
    dropEnabled && maxFiles > 0 && session.items.contains {
      preferredTypeIdentifier(for: $0.itemProvider) != nil
    }
  }

  func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnter session: UIDropSession) {
    onDropActive(["active": true])
  }

  func dropInteraction(
    _ interaction: UIDropInteraction,
    sessionDidUpdate session: UIDropSession
  ) -> UIDropProposal {
    UIDropProposal(operation: dropEnabled && maxFiles > 0 ? .copy : .cancel)
  }

  func dropInteraction(_ interaction: UIDropInteraction, sessionDidExit session: UIDropSession) {
    onDropActive(["active": false])
  }

  func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnd session: UIDropSession) {
    onDropActive(["active": false])
  }

  func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
    onDropActive(["active": false])
    let supportedItems = session.items.compactMap { item -> (NSItemProvider, String)? in
      guard let typeIdentifier = preferredTypeIdentifier(for: item.itemProvider) else { return nil }
      return (item.itemProvider, typeIdentifier)
    }
    let acceptedItems = Array(supportedItems.prefix(maxFiles))
    let budget = DropBudget(limit: maxTotalBytes)
    let group = DispatchGroup()
    let lock = NSLock()
    var files = Array<[String: String]?>(repeating: nil, count: acceptedItems.count)
    var errors: [String] = []

    if supportedItems.count > acceptedItems.count {
      errors.append("Only \(maxFiles) more file\(maxFiles == 1 ? "" : "s") can be added.")
    }
    if supportedItems.count < session.items.count {
      errors.append("Folders and some file types are not supported.")
    }

    for (index, item) in acceptedItems.enumerated() {
      let (provider, typeIdentifier) = item
      group.enter()
      loadDroppedFile(provider: provider, typeIdentifier: typeIdentifier, budget: budget) {
        file, error in
        lock.lock()
        files[index] = file
        if let error {
          errors.append(error)
        }
        lock.unlock()
        group.leave()
      }
    }

    group.notify(queue: .main) { [weak self] in
      let completed = files.compactMap { $0 }
      guard let self else {
        for file in completed {
          guard let uri = file["uri"], let url = URL(string: uri), url.isFileURL else { continue }
          try? FileManager.default.removeItem(at: url)
        }
        return
      }
      if !completed.isEmpty || !errors.isEmpty {
        self.onDropFiles(["files": completed, "errors": errors])
      }
    }
  }

  private func preferredTypeIdentifier(for provider: NSItemProvider) -> String? {
    let typed = provider.registeredTypeIdentifiers.compactMap { identifier -> (String, UTType)? in
      guard let type = UTType(identifier), !type.conforms(to: .directory) else { return nil }
      return (identifier, type)
    }
    return typed.first(where: { $0.1.conforms(to: .image) })?.0
      ?? typed.first(where: { $0.1.conforms(to: .content) && !$0.1.conforms(to: .fileURL) })?.0
      ?? typed.first(where: { $0.1.conforms(to: .data) && !$0.1.conforms(to: .fileURL) })?.0
  }

  private func loadDroppedFile(
    provider: NSItemProvider,
    typeIdentifier: String,
    budget: DropBudget,
    completion: @escaping ([String: String]?, String?) -> Void
  ) {
    provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, _ in
      guard let self, let url else {
        completion(nil, "Could not read \"\(self?.displayName(provider: provider, source: nil, typeIdentifier: typeIdentifier) ?? "Dropped file")\".")
        return
      }
      let name = displayName(provider: provider, source: url, typeIdentifier: typeIdentifier)
      do {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true else {
          completion(nil, "\"\(name)\" is not a regular file.")
          return
        }
        guard let size = values.fileSize, size <= maxFileBytes else {
          completion(nil, oversizeMessage(name: name))
          return
        }
        // Claimed before the copy, not after: the loads run concurrently, so a
        // check against bytes already written would let them all pass at once.
        guard budget.claim(size) else {
          completion(nil, dropFullMessage(name: name))
          return
        }
        let destination = dropDestination(fileName: name)
        try FileManager.default.copyItem(at: url, to: destination)
        let copiedSize = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard let copiedSize, copiedSize <= maxFileBytes else {
          try? FileManager.default.removeItem(at: destination)
          completion(nil, oversizeMessage(name: name))
          return
        }
        // The claim above was made against the source's reported size. A
        // provider that materializes something larger has to pay the
        // difference, or the per-drop ceiling would be advisory only.
        if copiedSize > size, !budget.claim(copiedSize - size) {
          try? FileManager.default.removeItem(at: destination)
          completion(nil, dropFullMessage(name: name))
          return
        }
        completion(descriptor(url: destination, typeIdentifier: typeIdentifier), nil)
      } catch {
        completion(nil, "Could not read \"\(name)\".")
      }
    }
  }

  private func oversizeMessage(name: String) -> String {
    let megabytes = Int((Double(maxFileBytes) / 1_000_000).rounded())
    return "\"\(name)\" is too large (max ~\(megabytes) MB per file)."
  }

  private func dropFullMessage(name: String) -> String {
    let megabytes = Int((Double(maxTotalBytes) / 1_000_000).rounded())
    return "\"\(name)\" was skipped (max ~\(megabytes) MB per drop)."
  }

  private func displayName(
    provider: NSItemProvider,
    source: URL?,
    typeIdentifier: String
  ) -> String {
    var fileName = provider.suggestedName ?? source?.lastPathComponent ?? "Dropped file"
    fileName = URL(fileURLWithPath: fileName).lastPathComponent
    fileName = fileName.components(separatedBy: .controlCharacters).joined()
    if fileName.isEmpty {
      fileName = "Dropped file"
    }
    if URL(fileURLWithPath: fileName).pathExtension.isEmpty,
       let suffix = UTType(typeIdentifier)?.preferredFilenameExtension {
      fileName += ".\(suffix)"
    }
    return truncateFileName(fileName, maxBytes: maximumDroppedFileNameBytes)
  }

  private func truncateFileName(_ fileName: String, maxBytes: Int) -> String {
    guard fileName.utf8.count > maxBytes else { return fileName }
    let path = URL(fileURLWithPath: fileName)
    let extensionWithDot = path.pathExtension.isEmpty ? "" : ".\(path.pathExtension)"
    let safeExtension = truncateUTF8(extensionWithDot, maxBytes: min(24, maxBytes))
    let stemBytes = max(1, maxBytes - safeExtension.utf8.count)
    let stem = truncateUTF8(path.deletingPathExtension().lastPathComponent, maxBytes: stemBytes)
    return "\(stem.isEmpty ? "File" : stem)\(safeExtension)"
  }

  private func truncateUTF8(_ value: String, maxBytes: Int) -> String {
    var result = ""
    for character in value {
      let candidate = result + String(character)
      if candidate.utf8.count > maxBytes { break }
      result = candidate
    }
    return result
  }

  private func dropDestination(fileName: String) -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "VerityDrops",
      isDirectory: true
    )
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("\(UUID().uuidString)-\(fileName)")
  }

  private func descriptor(url: URL, typeIdentifier: String) -> [String: String] {
    [
      "uri": url.absoluteString,
      "fileName": url.lastPathComponent.replacingOccurrences(
        of: #"^[0-9A-Fa-f-]{36}-"#,
        with: "",
        options: .regularExpression
      ),
      "mediaType": UTType(typeIdentifier)?.preferredMIMEType ?? "application/octet-stream",
    ]
  }
}
