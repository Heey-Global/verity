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
    case .alreadyRunning: return "Another voice recording is active."
    case .microphoneDenied: return "Microphone access is required for speech recognition."
    case .audioFormat: return "The microphone format could not be converted for speech recognition."
    }
  }
}

class VerityLiveSTT: Module {
  public func definition() -> ModuleDefinition {
    Name("VerityLiveSTT")
    Events("onSTTEvent", "onDictationEvent")

    AsyncFunction("engines") { () async -> [[String: Any]] in
      guard #available(iOS 26.0, *) else { return [] }
      return await LiveSTTService.shared.engines()
    }

    AsyncFunction("start") { (engine: String, locale: String, vocabulary: [String], participants: Int) async throws in
      guard #available(iOS 26.0, *) else {
        throw LiveSTTError.unavailable("The STT test requires iOS 26 or later.")
      }
      try await LiveSTTService.shared.start(
        engine: engine, locale: locale, vocabulary: vocabulary, participants: participants
      ) { [weak self] event in
        self?.sendEvent("onSTTEvent", event)
      }
    }

    AsyncFunction("dictationLocales") { () async -> [String] in
      guard #available(iOS 26.0, *), SpeechTranscriber.isAvailable else { return [] }
      return await SpeechTranscriber.supportedLocales.map { $0.identifier }
    }

    AsyncFunction("startDictation") { (session: String, locale: String, vocabulary: [String]) async throws in
      guard #available(iOS 26.0, *) else {
        throw LiveSTTError.unavailable("Voice input requires a supported iOS device.")
      }
      try await LiveSTTService.shared.start(
        engine: "apple-speech", locale: locale, vocabulary: vocabulary, participants: 0,
        owner: session
      ) { [weak self] event in
        var scoped = event
        scoped["session"] = session
        self?.sendEvent("onDictationEvent", scoped)
      }
    }

    AsyncFunction("stopDictation") { (session: String, abort: Bool) async throws in
      guard #available(iOS 26.0, *) else { return }
      try await LiveSTTService.shared.finishDictation(session: session, abort: abort)
    }

    AsyncFunction("stop") { () async throws in
      guard #available(iOS 26.0, *) else { return }
      try await LiveSTTService.shared.stopMeeting()
    }

    AsyncFunction("pause") { () async throws in
      guard #available(iOS 26.0, *) else { return }
      try await LiveSTTService.shared.pauseMeeting()
    }

    AsyncFunction("resume") { () async throws in
      guard #available(iOS 26.0, *) else { return }
      try await LiveSTTService.shared.resumeMeeting()
    }
  }
}

private struct SpeakerAudio: Sendable {
  let samples: [Float]
  let sampleRate: Double
}

private struct SpeakerUpdate: Sendable {
  let finalized: [DiarizerSegment]
  /// Turns still open at the end of the processed audio; replaced by the next update.
  let tentative: [DiarizerSegment]
  /// Audio seconds the diarizer has processed through, finalized or not.
  let through: Double
}

private actor LiveSpeakerProcessor {
  private enum Model {
    case sortformer(SortformerDiarizer)
    case lsEend(LSEENDDiarizer)
  }

  private let model: Model

  // FluidAudio's default timeline turns raw frame decisions into segments with no
  // smoothing, so every breath split a turn and words in the gaps lost their speaker.
  // These are NeMo's CALLHOME-tuned post-processing values for streaming Sortformer
  // v2 (diar_streaming_sortformer_4spk-v2_callhome-part1.yaml), except the minimum
  // speech length, shortened from 0.51 s so a brief "yes" keeps its speaker.
  private static func timelineConfig(frameDuration: Float) -> DiarizerTimelineConfig {
    DiarizerTimelineConfig(
      frameDurationSeconds: frameDuration,
      onsetThreshold: 0.641,
      offsetThreshold: 0.561,
      onsetPadSeconds: 0.229,
      offsetPadSeconds: 0.079,
      minDurationOn: 0.16,
      minDurationOff: 0.296)
  }

  init(participants: Int) async throws {
    // Frame durations come from the model and library defaults, so the smoothing
    // values in seconds map to the right number of frames for each variant.
    if participants > 4 {
      let lsEend = try await LSEENDModel.loadFromHuggingFace(
        variant: .dihard3, stepSize: .step100ms)
      model = .lsEend(
        try LSEENDDiarizer(
          model: lsEend,
          timelineConfig: Self.timelineConfig(
            frameDuration: lsEend.metadata.frameDurationSeconds)))
    } else {
      let config = SortformerConfig.default
      let models = try await SortformerModels.loadFromHuggingFace(config: config)
      let diarizer = SortformerDiarizer(
        config: config,
        timelineConfig: Self.timelineConfig(
          frameDuration: DiarizerTimelineConfig.sortformerDefault.frameDurationSeconds))
      diarizer.initialize(models: models)
      model = .sortformer(diarizer)
    }
  }

  func process(_ audio: SpeakerAudio) throws -> SpeakerUpdate? {
    let update: DiarizerTimelineUpdate?
    let frameDuration: Float
    switch model {
    case .sortformer(let diarizer):
      update = try diarizer.process(samples: audio.samples, sourceSampleRate: audio.sampleRate)
      frameDuration = diarizer.timeline.config.frameDurationSeconds
    case .lsEend(let diarizer):
      update = try diarizer.process(samples: audio.samples, sourceSampleRate: audio.sampleRate)
      frameDuration = diarizer.timeline.config.frameDurationSeconds
    }
    guard let update else { return nil }
    let chunk = update.chunkResult
    let frames = chunk.startFrame + chunk.finalizedFrameCount + chunk.tentativeFrameCount
    return SpeakerUpdate(
      finalized: update.finalizedSegments, tentative: update.tentativeSegments,
      through: Double(Float(frames) * frameDuration))
  }

  func finish() throws -> [DiarizerSegment] {
    let update: DiarizerTimelineUpdate?
    switch model {
    case .sortformer(let diarizer): update = try diarizer.finalizeSession()
    case .lsEend(let diarizer): update = try diarizer.finalizeSession()
    }
    return update?.finalizedSegments ?? []
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
  private var speakerProcessor: LiveSpeakerProcessor?
  private var speakerModelTask: Task<LiveSpeakerProcessor?, Never>?
  private var speakerInput: AsyncStream<SpeakerAudio>.Continuation?
  private var speakerTask: Task<Void, Never>?
  private var speakerUnavailable = false
  private var emit: (([String: Any]) -> Void)?
  private var activeEngine: String?
  private var dictationOwner: String?
  private var generation = 0
  private var reportedOverflow = false
  private var paused = false
  private var emittedWordCount = 0

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
    engine: String, locale: String, vocabulary: [String], participants: Int, owner: String? = nil,
    emit: @escaping ([String: Any]) -> Void
  ) async throws {
    guard activeEngine == nil else { throw LiveSTTError.alreadyRunning }
    generation += 1
    let startGeneration = generation
    activeEngine = engine
    dictationOwner = owner
    paused = false
    reportedOverflow = false
    speakerUnavailable = false
    emittedWordCount = 0
    self.emit = emit
    emit(["kind": "status", "state": "preparing", "engine": engine])

    do {
      guard await AVAudioApplication.requestRecordPermission() else {
        throw LiveSTTError.microphoneDenied
      }
      try ensureActive(startGeneration)
      if participants > 0 {
        emit(["kind": "speaker-status", "state": "loading"])
        speakerModelTask = Task { [weak self] in
          do {
            let processor = try await LiveSpeakerProcessor(participants: participants)
            guard let self, self.generation == startGeneration, self.activeEngine != nil,
              !self.speakerUnavailable else {
              return nil
            }
            self.speakerProcessor = processor
            self.emit?(["kind": "speaker-status", "state": "ready"])
            return processor
          } catch {
            guard let self, self.generation == startGeneration, self.activeEngine != nil,
              !self.speakerUnavailable else {
              return nil
            }
            self.speakerUnavailable = true
            self.speakerInput?.finish()
            self.emit?(["kind": "speaker-status", "state": "unavailable", "message": error.localizedDescription])
            return nil
          }
        }
      }
      switch engine {
      case "apple-speech":
        try await startSpeechTranscriber(locale: locale, vocabulary: vocabulary, generation: startGeneration)
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
        let failedAnalyzer = analyzer
        let failedParakeet = parakeet
        await failedAnalyzer?.cancelAndFinishNow()
        await failedParakeet?.cancel()
        if generation == startGeneration { clear() }
      }
      throw error
    }
  }

  func stopMeeting() async throws {
    guard dictationOwner == nil else { return }
    try await stop()
  }

  func pauseMeeting() throws {
    guard dictationOwner == nil else { return }
    try pause()
  }

  func resumeMeeting() throws {
    guard dictationOwner == nil else { return }
    try resume()
  }

  func finishDictation(session: String, abort: Bool) async throws {
    guard dictationOwner == session else { return }
    if !abort { try await stop(); return }
    generation += 1
    stopMicrophone()
    let currentAnalyzer = analyzer
    resultsTask?.cancel()
    processingTask?.cancel()
    clear()
    await currentAnalyzer?.cancelAndFinishNow()
  }

  func stop() async throws {
    guard let engine = activeEngine else { return }
    generation += 1
    let stopGeneration = generation
    let wasCapturing = audioEngine != nil
    stopMicrophone()
    if speakerProcessor == nil {
      speakerModelTask?.cancel()
      speakerTask?.cancel()
    }
    if !wasCapturing {
      let stoppingAnalyzer = analyzer
      let stoppingParakeet = parakeet
      resultsTask?.cancel()
      await stoppingAnalyzer?.cancelAndFinishNow()
      await stoppingParakeet?.cancel()
      if generation == stopGeneration { clear() }
      return
    }
    do {
      // Drain every captured buffer before asking the recognizer to finalize.
      try await processingTask?.value
      guard generation == stopGeneration else { return }
      if speakerProcessor != nil { await speakerTask?.value }
      if let speakerProcessor, !speakerUnavailable {
        if let segments = try? await speakerProcessor.finish() { emitSpeakerSegments(segments) }
      }
      if let analyzer {
        try await analyzer.finalizeAndFinishThroughEndOfInput()
      } else if let nemotron {
        let (text, timings) = try await nemotron.finishWithTokenTimings()
        emitWords(buildWordTimings(from: timings), includeLast: true)
        emit?(["kind": "snapshot", "text": text, "final": true])
        await nemotron.reset()
      } else if let parakeet {
        let text = try await parakeet.finish()
        emit?(["kind": "snapshot", "text": text, "final": true])
        await parakeet.cancel()
      }
      try await resultsTask?.value
      guard generation == stopGeneration else { return }
      emit?(["kind": "status", "state": "stopped", "engine": engine])
      clear()
    } catch {
      guard generation == stopGeneration else { throw error }
      let stoppingAnalyzer = analyzer
      let stoppingParakeet = parakeet
      await stoppingAnalyzer?.cancelAndFinishNow()
      await stoppingParakeet?.cancel()
      if generation == stopGeneration { clear() }
      throw error
    }
  }

  func pause() throws {
    guard let engine = activeEngine, let audioEngine else {
      throw LiveSTTError.unavailable("The microphone is not ready to pause.")
    }
    guard !paused else { return }
    audioEngine.pause()
    do {
      try AVAudioSession.sharedInstance().setActive(false)
    } catch {
      try? audioEngine.start()
      throw error
    }
    paused = true
    emit?(["kind": "status", "state": "paused", "engine": engine])
  }

  func resume() throws {
    guard let engine = activeEngine, let audioEngine else {
      throw LiveSTTError.unavailable("The microphone is not ready to resume.")
    }
    guard paused else { return }
    try AVAudioSession.sharedInstance().setActive(true)
    do {
      try audioEngine.start()
    } catch {
      try? AVAudioSession.sharedInstance().setActive(false)
      throw error
    }
    paused = false
    emit?(["kind": "status", "state": "listening", "engine": engine])
  }

  private func clear() {
    speakerTask?.cancel()
    speakerModelTask?.cancel()
    audioEngine = nil
    microphoneInput = nil
    analyzerInput = nil
    processingTask = nil
    resultsTask = nil
    analyzer = nil
    nemotron = nil
    parakeet = nil
    speakerProcessor = nil
    speakerModelTask = nil
    speakerInput = nil
    speakerTask = nil
    speakerUnavailable = false
    activeEngine = nil
    dictationOwner = nil
    paused = false
    emit = nil
  }

  private func startSpeechTranscriber(locale: String, vocabulary: [String], generation: Int) async throws {
    guard SpeechTranscriber.isAvailable,
      let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale))
    else {
      throw LiveSTTError.unavailable("Apple SpeechTranscriber does not support this device or locale.")
    }
    let transcriber = SpeechTranscriber(locale: supported, preset: .timeIndexedProgressiveTranscription)
    try await prepareApple(transcriber, generation: generation)
    try ensureActive(generation)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    if dictationOwner != nil && !vocabulary.isEmpty {
      // SpeechTranscriber currently ignores contextual strings; local correction
      // handles vocabulary until the framework supports recognition hints.
      let context = AnalysisContext()
      context.contextualStrings[.general] = Array(vocabulary.prefix(100))
      try await analyzer.setContext(context)
      try ensureActive(generation)
    }
    self.analyzer = analyzer
    resultsTask = Task {
      do {
        for try await result in transcriber.results {
          guard self.analyzer === analyzer else { return }
          self.emitAppleResult(
            text: result.text, start: result.range.start,
            end: CMTimeRangeGetEnd(result.range), final: result.isFinal)
        }
      } catch {
        if self.analyzer === analyzer { await self.failCapture(error) }
        throw error
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
          text: result.text, start: result.range.start,
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
    try ensureActive(generation)
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
          if self.analyzer === analyzer { await self.failCapture(error) }
          throw error
        }
      }
    }
  }

  private func emitAppleResult(text: AttributedString, start: CMTime, end: CMTime, final: Bool) {
    var event: [String: Any] = [
      "kind": "segment", "text": String(text.characters), "final": final,
      "start": CMTimeGetSeconds(start), "end": CMTimeGetSeconds(end),
    ]
    // One range for the whole phrase includes its pauses, which the diarizer does not
    // mark as anyone's speech; per-run ranges let each word find its speaker.
    if final {
      event["runs"] = text.runs.map { run -> [String: Any] in
        var entry: [String: Any] = ["text": String(text[run.range].characters)]
        if let range = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self],
          range.isValid, CMTimeGetSeconds(range.duration) > 0
        {
          entry["start"] = CMTimeGetSeconds(range.start)
          entry["end"] = CMTimeGetSeconds(CMTimeRangeGetEnd(range))
        }
        return entry
      }
    }
    emit?(event)
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
              self.emitWords(buildWordTimings(from: await manager.getTokenTimings()), includeLast: false)
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
    if let speakerModelTask, !speakerUnavailable {
      let (speakerStream, input) = AsyncStream<SpeakerAudio>.makeStream(
        bufferingPolicy: .bufferingNewest(512))
      speakerInput = input
      speakerTask = Task {
        guard let speakerProcessor = await speakerModelTask.value else { return }
        for await chunk in speakerStream {
          if speakerUnavailable { break }
          do {
            if let update = try await speakerProcessor.process(chunk) {
              emitSpeakerSegments(update.finalized)
              emitTentativeSpeakers(update)
            }
          } catch {
            speakerUnavailable = true
            speakerInput?.finish()
            emit?(["kind": "speaker-status", "state": "unavailable", "message": error.localizedDescription])
            break
          }
        }
      }
    }
    let speakerContinuation = speakerInput
    let captureGeneration = generation
    let reportLevel = dictationOwner != nil
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
      guard let copy = Self.copyBuffer(buffer) else { return }
      if reportLevel, let channel = copy.floatChannelData?.pointee, copy.frameLength > 0 {
        let samples = UnsafeBufferPointer(start: channel, count: Int(copy.frameLength))
        let rms = sqrt(samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(copy.frameLength))
        let level = min(1, max(0, rms * 10))
        Task { @MainActor [weak self] in
          guard let self, self.generation == captureGeneration else { return }
          self.emit?(["kind": "level", "value": level])
        }
      }
      if let channel = copy.floatChannelData?.pointee, let speakerContinuation {
        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(copy.frameLength)))
        if case .dropped = speakerContinuation.yield(
          SpeakerAudio(samples: samples, sampleRate: copy.format.sampleRate)) {
          speakerContinuation.finish()
          Task { @MainActor [weak self] in
            guard let self, !self.speakerUnavailable else { return }
            self.speakerUnavailable = true
            self.speakerModelTask?.cancel()
            self.emit?(["kind": "speaker-status", "state": "unavailable", "message": "Speaker recognition fell behind audio capture."])
          }
        }
      }
      if case .dropped = continuation.yield(copy) {
        Task { @MainActor [weak self] in
          guard let self, self.generation == captureGeneration, !self.reportedOverflow else { return }
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
      speakerContinuation?.finish()
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
    speakerInput?.finish()
    try? AVAudioSession.sharedInstance().setActive(false)
  }

  private func emitSpeakerSegments(_ segments: [DiarizerSegment]) {
    for segment in segments {
      guard segment.endTime > segment.startTime else { continue }
      emit?([
        "kind": "speaker", "speaker": segment.speakerIndex,
        "start": segment.startTime, "end": segment.endTime,
      ])
    }
  }

  private func emitTentativeSpeakers(_ update: SpeakerUpdate) {
    emit?([
      "kind": "speaker-tentative",
      "turns": update.tentative.filter { $0.endTime > $0.startTime }.map {
        ["speaker": $0.speakerIndex, "start": $0.startTime, "end": $0.endTime] as [String: Any]
      },
      "through": update.through,
    ])
  }

  private func emitWords(_ words: [WordTiming], includeLast: Bool) {
    let count = includeLast ? words.count : max(0, words.count - 1)
    if count < emittedWordCount { emittedWordCount = 0 }
    guard count > emittedWordCount else { return }
    let added = words[emittedWordCount..<count].map { word in
      ["text": word.word, "start": word.startTime, "end": word.endTime] as [String: Any]
    }
    emittedWordCount = count
    emit?(["kind": "words", "words": added])
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
