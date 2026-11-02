import Foundation
import CryptoKit
import EXUpdates

// Read Expo's launched asset, never its downloaded/pending update. A native
// snapshot keeps JS metadata or an embedded manifest from labeling an OTA trace.
@objc(VerityProfileBundleIdentity)
public final class ProfileBundleIdentity: NSObject {
  @objc public static func snapshot() throws -> NSDictionary {
    guard AppController.isInitialized() else {
      throw NSError(domain: "VerityCPUProfiler", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Updates controller is not initialized."])
    }
    let controller = AppController.sharedInstance
    guard let url = controller.launchAssetUrl(), url.isFileURL,
          let stream = InputStream(url: url) else {
      throw NSError(domain: "VerityCPUProfiler", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "A local launch bundle is required."])
    }
    let constants = controller.getConstantsForModule().toModuleConstantsMap().compactMapValues { $0 }
    stream.open()
    defer { stream.close() }
    var hash = SHA256()
    var bytes = [UInt8](repeating: 0, count: 65536)
    var total = 0
    while true {
      let count = stream.read(&bytes, maxLength: bytes.count)
      if count < 0 { throw stream.streamError ?? NSError(domain: "VerityCPUProfiler", code: 3) }
      if count == 0 { break }
      total += count
      hash.update(data: Data(bytes.prefix(count)))
    }
    guard total > 0 else { throw NSError(domain: "VerityCPUProfiler", code: 4) }
    let current = controller.getConstantsForModule().toModuleConstantsMap().compactMapValues { $0 }
    for key in ["updateId", "runtimeVersion", "isEmbeddedLaunch"] {
      let before = constants[key] as? NSObject
      let after = current[key] as? NSObject
      if before != after || controller.launchAssetUrl() != url {
        throw NSError(domain: "VerityCPUProfiler", code: 5,
                      userInfo: [NSLocalizedDescriptionKey: "Bundle changed while identifying it."])
      }
    }
    var identity: [String: Any] = [
      "bundleSha256": hash.finalize().map { String(format: "%02x", $0) }.joined(),
      "updatesEnabled": constants["isEnabled"] as? Bool ?? false,
      "isEmbeddedLaunch": constants["isEmbeddedLaunch"] as? Bool ?? true,
      "updateId": constants["updateId"] as? String ?? "",
      "runtimeVersion": constants["runtimeVersion"] as? String ?? ""
    ]
    let info = Bundle.main.infoDictionary ?? [:]
    identity["bundleId"] = Bundle.main.bundleIdentifier ?? ""
    identity["nativeVersion"] = info["CFBundleShortVersionString"] as? String ?? ""
    identity["nativeBuild"] = info["CFBundleVersion"] as? String ?? ""
    return identity as NSDictionary
  }
}
