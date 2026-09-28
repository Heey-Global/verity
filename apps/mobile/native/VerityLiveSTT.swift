internal import ExpoModulesCore
import AVFoundation
import FluidAudio
import Foundation
import Speech

private enum LiveSTTError: LocalizedError {
  case unavailable(String)
  case alreadyRunning
  case microphoneDenied
  case audioFormat

  var errorDescription: String? {
    switch self {
    case .unavailable(let reason): return reason
    case .alreadyRunning: return "A transcription test is already running."
    case .microphoneDenied: return "Microphone access is required for the STT test."
    case .audioFormat: return "The microphone format could not be converted for speech recognition."
    }
  }
}

class VerityLiveSTT: Module {
  public func definition() -> ModuleDefinition {
    Name("VerityLiveSTT")
    Events("onSTTEvent")

    AsyncFunction("engines") { () async -> [[String: Any]] in
      guard #available(iOS 26.0, *) else { return [] }
      return await LiveSTTService.shared.engines()
    }

    AsyncFunction("start") { (engine: String, locale: String, vocabulary: [String]) async throws in
      guard #available(iOS 26.0, *) else {
        throw LiveSTTError.unavailable("The STT test requires iOS 26 or later.")
      }
      try await LiveSTTService.shared.start(
        engine: engine, locale: locale, vocabulary: vocabulary
      ) { [weak self] event in
        self?.sendEvent("onSTTEvent", event)
      }
    }

    AsyncFunction("stop") { () async throws in
      guard #available(iOS 26.0, *) else { return }
      try await LiveSTTService.shared.stop()
    }
  }
}

// A single microphone owner keeps the test independent of the screen mount.
// Leaving the test screen calls stop; V1 will replace this with durable capture.
@available(iOS 26.0, *)
@MainActor
private final class LiveSTTService {
  static let shared = LiveSTTService()

  private var audioEngine: AVAudioEngine?
  private var microphoneInput: AsyncStream<AVAudioPCMBuffer>.Continuation?
  private var processingTask: Task<Void, Error>?
  private var resultsTask: Task<Void, Error>?
  private var analyzerInput: AsyncStream<AnalyzerInput>.Continuation?
  private var analyzer: SpeechAnalyzer?
  private var nemotron: StreamingNemotronMultilingualAsrManager?
  private var parakeet: SlidingWindowAsrManager?
  private var emit: (([String: Any]) -> Void)?
  private var activeEngine: String?
  private var generation = 0
  private var reportedOverflow = false

  func engines() async -> [[String: Any]] {
    let appleAvailable = SpeechTranscriber.isAvailable
    return [
      ["id": "apple-speech", "name": "Apple SpeechTranscriber", "available": appleAvailable],
      ["id": "apple-dictation", "name": "Apple DictationTranscriber", "available": true],
      ["id": "fluid-nemotron", "name": "FluidAudio Nemotron", "available": true],
      ["id": "fluid-parakeet", "name": "FluidAudio Parakeet Ultra", "available": true],
    ]
  }

  func start(
    engine: String, locale: String, vocabulary: [String],
    emit: @escaping ([String: Any]) -> Void
  ) async throws {
    guard activeEngine == nil else { throw LiveSTTError.alreadyRunning }
    guard await AVAudioApplication.requestRecordPermission() else {
      throw LiveSTTError.microphoneDenied
    }
    generation += 1
    let startGeneration = generation
    activeEngine = engine
    reportedOverflow = false
    self.emit = emit
    emit(["kind": "status", "state": "preparing", "engine": engine])

    do {
      switch engine {
      case "apple-speech":
        try await startSpeechTranscriber(locale: locale, generation: startGeneration)
      case "apple-dictation":
        try await startDictationTranscriber(
          locale: locale, vocabulary: vocabulary, generation: startGeneration)
      case "fluid-nemotron":
        try await startNemotron(locale: locale, vocabulary: vocabulary, generation: startGeneration)
      case "fluid-parakeet":
        try await startParakeet(generation: startGeneration)
      default:
        throw LiveSTTError.unavailable("Unknown transcription engine: \(engine)")
      }
      guard generation == startGeneration else { return }
      emit(["kind": "status", "state": "listening", "engine": engine])
    } catch {
      if generation == startGeneration {
        stopMicrophone()
        await analyzer?.cancelAndFinishNow()
        await parakeet?.cancel()
        clear()
      }
      throw error
    }
  }

  func stop() async throws {
    guard let engine = activeEngine else { return }
    generation += 1
    let wasCapturing = audioEngine != nil
    stopMicrophone()
    if !wasCapturing {
      await analyzer?.cancelAndFinishNow()
      await parakeet?.cancel()
      resultsTask?.cancel()
      clear()
      return
    }
    do {
      // Drain every captured buffer before asking the recognizer to finalize.
      try await processingTask?.value
      if let analyzer {
        try await analyzer.finalizeAndFinishThroughEndOfInput()
      } else if let nemotron {
        let text = try await nemotron.finish()
        emit?(["kind": "snapshot", "text": text, "final": true])
        await nemotron.reset()
      } else if let parakeet {
        let text = try await parakeet.finish()
        emit?(["kind": "snapshot", "text": text, "final": true])
        await parakeet.cancel()
      }
      try await resultsTask?.value
      emit?(["kind": "status", "state": "stopped", "engine": engine])
      clear()
    } catch {
      await analyzer?.cancelAndFinishNow()
      await parakeet?.cancel()
      clear()
      throw error
    }
  }

  private func clear() {
    audioEngine = nil
    microphoneInput = nil
    analyzerInput = nil
    processingTask = nil
    resultsTask = nil
    analyzer = nil
    nemotron = nil
    parakeet = nil
    activeEngine = nil
    emit = nil
  }

  private func startSpeechTranscriber(locale: String, generation: Int) async throws {
    guard SpeechTranscriber.isAvailable,
      let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale))
    else {
      throw LiveSTTError.unavailable("Apple SpeechTranscriber does not support this device or locale.")
    }
    let transcriber = SpeechTranscriber(locale: supported, preset: .timeIndexedProgressiveTranscription)
    try await prepareApple(transcriber, generation: generation)
    try ensureActive(generation)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    self.analyzer = analyzer
    resultsTask = Task {
      for try await result in transcriber.results {
        self.emitAppleResult(
          text: String(result.text.characters), start: result.range.start,
          end: CMTimeRangeGetEnd(result.range), final: result.isFinal)
      }
    }
    try await startAppleMicrophone(
      analyzer: analyzer, module: transcriber, generation: generation)
  }

  private func startDictationTranscriber(
    locale: String, vocabulary: [String], generation: Int
  ) async throws {
    guard let supported = await DictationTranscriber.supportedLocale(
      equivalentTo: Locale(identifier: locale))
    else { throw LiveSTTError.unavailable("Apple DictationTranscriber does not support this locale.") }
    let transcriber = DictationTranscriber(
      locale: supported,
      contentHints: [.farField],
      transcriptionOptions: [.punctuation],
      reportingOptions: [.volatileResults, .frequentFinalization],
      attributeOptions: [.audioTimeRange])
    try await prepareApple(transcriber, generation: generation)
    try ensureActive(generation)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    if !vocabulary.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings[.general] = Array(vocabulary.prefix(100))
      try await analyzer.setContext(context)
    }
    self.analyzer = analyzer
    resultsTask = Task {
      for try await result in transcriber.results {
        self.emitAppleResult(
          text: String(result.text.characters), start: result.range.start,
          end: CMTimeRangeGetEnd(result.range), final: result.isFinal)
      }
    }
    try await startAppleMicrophone(
      analyzer: analyzer, module: transcriber, generation: generation)
  }

  private func prepareApple(_ module: any SpeechModule, generation: Int) async throws {
    for _ in 0..<300 {
      try ensureActive(generation)
      switch await AssetInventory.status(forModules: [module]) {
      case .installed: return
      case .supported:
        emit?(["kind": "status", "state": "downloading"])
        // A nil request means the asset was installed after the status check.
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module])
        else { return }
        try await request.downloadAndInstall()
        return
      case .downloading:
        emit?(["kind": "status", "state": "downloading"])
      case .unsupported:
        throw LiveSTTError.unavailable("The selected Apple language assets are unavailable.")
      @unknown default:
        throw LiveSTTError.unavailable("Unknown Apple language asset state.")
      }
      try await Task.sleep(for: .seconds(1))
    }
    throw LiveSTTError.unavailable("The Apple language assets did not finish downloading.")
  }

  private func startAppleMicrophone(
    analyzer: SpeechAnalyzer, module: any SpeechModule, generation: Int
  ) async throws {
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
      throw LiveSTTError.audioFormat
    }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    analyzerInput = continuation
    try await analyzer.start(inputSequence: stream)
    try ensureActive(generation)
    try startMicrophone { microphoneStream in
      self.processingTask = Task {
        defer { continuation.finish() }
        var converter: AVAudioConverter?
        do {
          for await buffer in microphoneStream {
            if converter?.inputFormat.isEqual(buffer.format) != true {
              converter = AVAudioConverter(from: buffer.format, to: format)
            }
            guard let converter else { throw LiveSTTError.audioFormat }
            let capacity = AVAudioFrameCount(
              ceil(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1024)
            var suppliedInput = false
            while true {
              guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
                throw LiveSTTError.audioFormat
              }
              var conversionError: NSError?
              let result = converter.convert(to: converted, error: &conversionError) {
                _, inputStatus in
                guard !suppliedInput else {
                  inputStatus.pointee = .noDataNow
                  return nil
                }
                suppliedInput = true
                inputStatus.pointee = .haveData
                return buffer
              }
              if let conversionError { throw conversionError }
              if converted.frameLength > 0 {
                continuation.yield(AnalyzerInput(buffer: converted))
              }
              if result != .haveData || converted.frameLength == 0 { break }
            }
          }
        } catch {
          await self.failCapture(error)
          throw error
        }
      }
    }
  }

  private func emitAppleResult(text: String, start: CMTime, end: CMTime, final: Bool) {
    emit?([
      "kind": "segment", "text": text, "final": final,
      "start": CMTimeGetSeconds(start), "end": CMTimeGetSeconds(end),
    ])
  }

  private func startNemotron(
    locale: String, vocabulary: [String], generation: Int
  ) async throws {
    emit?(["kind": "status", "state": "downloading"])
    let models = try await StreamingNemotronMultilingualAsrManager.downloadAndPreloadShared(
      languageCode: locale, chunkMs: 2240)
    try ensureActive(generation)
    let manager = StreamingNemotronMultilingualAsrManager()
    try await manager.loadFromShared(models)
    await manager.setLanguage(locale)
    await manager.setCustomVocabulary(vocabulary.prefix(100).map { CustomVocabularyTerm(text: $0) })
    try ensureActive(generation)
    nemotron = manager
    try startMicrophone { microphoneStream in
      self.processingTask = Task {
        var last = ""
        do {
          for await buffer in microphoneStream {
            _ = try await manager.process(audioBuffer: buffer)
            let text = await manager.getPartialTranscript()
            if text != last {
              last = text
              self.emit?(["kind": "snapshot", "text": text, "final": false])
            }
          }
        } catch {
          await self.failCapture(error)
          throw error
        }
      }
    }
  }

  private func startParakeet(generation: Int) async throws {
    emit?(["kind": "status", "state": "downloading"])
    let models = try await AsrModels.downloadAndLoad(version: .ultra)
    try ensureActive(generation)
    // The default 11 s chunk plus 2 s lookahead leaves short test recordings blank.
    let manager = SlidingWindowAsrManager(config: SlidingWindowAsrConfig(
      chunkSeconds: 3.0, leftContextSeconds: 2.0, rightContextSeconds: 0.5))
    try await manager.loadModels(models)
    try await manager.startStreaming()
    try ensureActive(generation)
    parakeet = manager
    resultsTask = Task {
      for await _ in await manager.transcriptionUpdates {
        let confirmed = await manager.confirmedTranscript
        let volatile = await manager.volatileTranscript
        let text = [confirmed, volatile].filter { !$0.isEmpty }.joined(separator: " ")
        self.emit?(["kind": "snapshot", "text": text, "final": false])
      }
    }
    try startMicrophone { microphoneStream in
      self.processingTask = Task {
        for await buffer in microphoneStream { await manager.streamAudio(buffer) }
      }
    }
  }

  private func startMicrophone(
    consume: (AsyncStream<AVAudioPCMBuffer>) throws -> Void
  ) throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement)
    try session.setActive(true)
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    let (stream, continuation) = AsyncStream<AVAudioPCMBuffer>.makeStream(
      bufferingPolicy: .bufferingNewest(32))
    microphoneInput = continuation
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
      guard let copy = Self.copyBuffer(buffer) else { return }
      if case .dropped = continuation.yield(copy) {
        Task { @MainActor [weak self] in
          guard let self, !self.reportedOverflow else { return }
          self.reportedOverflow = true
          await self.failCapture(LiveSTTError.unavailable("Audio capture fell behind and part of the test was lost."))
        }
      }
    }
    do {
      try consume(stream)
      try engine.start()
      audioEngine = engine
    } catch {
      input.removeTap(onBus: 0)
      continuation.finish()
      throw error
    }
  }

  nonisolated private static func copyBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let copy = AVAudioPCMBuffer(
      pcmFormat: buffer.format, frameCapacity: buffer.frameLength),
      let source = buffer.floatChannelData, let target = copy.floatChannelData
    else { return nil }
    copy.frameLength = buffer.frameLength
    for channel in 0..<Int(buffer.format.channelCount) {
      target[channel].update(from: source[channel], count: Int(buffer.frameLength))
    }
    return copy
  }

  private func stopMicrophone() {
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()
    microphoneInput?.finish()
    try? AVAudioSession.sharedInstance().setActive(false)
  }

  private func failCapture(_ error: Error) async {
    generation += 1
    stopMicrophone()
    emit?(["kind": "status", "state": "failed", "message": error.localizedDescription])
    let analyzer = analyzer
    let parakeet = parakeet
    resultsTask?.cancel()
    clear()
    await analyzer?.cancelAndFinishNow()
    await parakeet?.cancel()
  }

  private func ensureActive(_ expectedGeneration: Int) throws {
    guard activeEngine != nil && generation == expectedGeneration else {
      throw LiveSTTError.unavailable("The STT test was stopped while preparing the model.")
    }
  }
}
