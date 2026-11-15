import CoreML
import Foundation

/// Keeps a CoreML model that crashed the app while loading from crashing it on every start.
///
/// CoreML can fault while compiling a model for the Neural Engine
/// (`MLE5ProgramLibraryOnDeviceAOTCompilationImpl`). That ends the process: no Swift error
/// reaches the caller, so the next recording would load the same model the same way and
/// crash again. A marker is written before each load and removed when the load returns or
/// throws. A marker still present at the next load means that load never returned, and that
/// model steps down a compute-unit level: first without the Neural Engine, then CPU only.
///
/// The marker is withdrawn while the app is in the background, so iOS ending a suspended
/// app, or the user closing it from the app switcher, is not taken for a crash. In exchange
/// a crash while loading in the background goes unnoticed; loads start from a foreground
/// tap. Levels are kept per model until the system or app build changes, since either may
/// fix the fault (a new build can carry a new CoreML library or model).
final class LiveModelCrashGuard: @unchecked Sendable {
  static let shared = LiveModelCrashGuard()

  private enum Level: Int, Codable {
    case standard, withoutNeuralEngine, cpuOnly
  }

  private struct State: Codable {
    var system: String
    var levels: [String: Level] = [:]
    var loading: String?
  }

  private let lock = NSLock()
  private let url: URL?
  /// The model loading in this process, whether or not its marker is currently written.
  private var current: String?
  private var observers: [NSObjectProtocol] = []

  private init() {
    url = try? FileManager.default
      .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("VerityLiveModelLoads.json")
    // Settled before the background observers below can withdraw the marker it reads.
    var state = read()
    if let crashed = state.loading {
      // The last load of an earlier process never returned: it brought the app down.
      let level = state.levels[crashed] ?? .standard
      state.levels[crashed] = Level(rawValue: level.rawValue + 1) ?? .cpuOnly
      state.loading = nil
      write(state)
      NSLog("[VerityLiveSTT] %@ did not finish loading last time; loading it with fewer compute units", crashed)
    }
    // The UIApplication constants are main-actor isolated; this may first run on a model
    // loading task, so the observers use their underlying names.
    let center = NotificationCenter.default
    observers = [
      center.addObserver(
        forName: Notification.Name("UIApplicationDidEnterBackgroundNotification"), object: nil, queue: nil
      ) { [weak self] _ in self?.mark(nil) },
      center.addObserver(
        forName: Notification.Name("UIApplicationWillEnterForegroundNotification"), object: nil, queue: nil
      ) { [weak self] _ in self?.restoreMarker() },
    ]
  }

  /// Records that `model` starts loading and returns the compute units to load it with:
  /// nil keeps the library default. Call `finished(_:)` once the load returns or throws.
  func begin(_ model: String) -> MLComputeUnits? {
    lock.lock()
    defer { lock.unlock() }
    var state = read()
    state.loading = model
    current = model
    write(state)
    switch state.levels[model] ?? .standard {
    case .standard: return nil
    case .withoutNeuralEngine: return .cpuAndGPU
    case .cpuOnly: return .cpuOnly
    }
  }

  func finished(_ model: String) {
    lock.lock()
    defer { lock.unlock() }
    guard current == model else { return }
    current = nil
    var state = read()
    state.loading = nil
    write(state)
  }

  /// Writes the marker again for a load still running when the app returns to the foreground.
  /// Reads `current` under the same lock, so a load finishing meanwhile is not marked again.
  private func restoreMarker() {
    lock.lock()
    defer { lock.unlock() }
    markLocked(current)
  }

  private func mark(_ model: String?) {
    lock.lock()
    defer { lock.unlock() }
    markLocked(model)
  }

  private func markLocked(_ model: String?) {
    var state = read()
    guard state.loading != model else { return }
    state.loading = model
    write(state)
  }

  private func read() -> State {
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
    let system = "\(ProcessInfo.processInfo.operatingSystemVersionString) app \(build)"
    guard let url, let data = try? Data(contentsOf: url),
      let state = try? JSONDecoder().decode(State.self, from: data),
      state.system == system
    else { return State(system: system) }
    return state
  }

  private func write(_ state: State) {
    guard let url, let data = try? JSONEncoder().encode(state) else { return }
    // Written before CoreML starts: the file must be on disk when the process dies.
    try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
}
