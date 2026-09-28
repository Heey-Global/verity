# Live Meeting: speech-to-text options

**Status:** Investigation, 2026-09-28. Companion to [LIVE_MEETING_CONCEPT.md](LIVE_MEETING_CONCEPT.md)
and [LIVE_MEETING_CONCEPT_REVIEW.md](LIVE_MEETING_CONCEPT_REVIEW.md).
**Question:** What does Apple provide natively on iOS 26/27, where must Verity add components, is
FluidAudio the right complement, and are there better alternatives?
**Method:** Apple documentation, vendor documentation and repositories, and two third-party
benchmarks, all read on the investigation date. No measurement on the target devices.

## 1. What Apple provides natively

iOS 26 replaced the dictation-era API with the `SpeechAnalyzer` framework. Three modules matter:

| Module | What it is | Relevant properties |
| --- | --- | --- |
| `SpeechTranscriber` | Apple's long-form conversational speech-to-text, on device | Volatile plus finalized results, word-level `audioTimeRange`, alternative transcriptions, `fastResults`, etiquette filtering. No session length limit. Runs outside the app process, so model memory is not counted against the app. Language assets are installed through the system catalog via `AssetInventory`; nothing is bundled or downloaded by the app. |
| `DictationTranscriber` | The same models as on-device `SFSpeechRecognizer`, for older devices and locales | Supports `contextualStrings` through `AnalysisContext` (up to 100 short phrases), custom language models via `SFCustomLanguageModelData`, and content hints such as distant speech. |
| `SpeechDetector` | Voice activity detection | Can gate transcription on speech. |

German is supported: `de_DE`, `de_AT` and `de_CH` are in the 42 supported locales, alongside 21
other languages. One transcriber handles one locale; there is no mid-stream language switching and
no automatic language detection. Hardware eligibility is a runtime check
(`SpeechTranscriber.supportsDevice()`); Apple does not publish a device list. The iPhone 15 Pro and
the M2 iPad Pro are Apple Intelligence class devices and are expected to qualify, but this must be
confirmed on the device.

Quality evidence available today:

- A vendor benchmark of 13,023 recordings in five languages (Dictato, April 2026) reports Apple's
  engine as the best on-device engine for clean German read speech at 6.7 % WER, ahead of WhisperKit
  and Parakeet, while Parakeet wins on disfluent, conversational speech in three of five languages.
  All engines fail similarly on technical jargon; LLM proofreading roughly halved jargon errors.
- Argmax (June 2025, English earnings calls) places Apple between Whisper base and Whisper small
  in accuracy, with Parakeet v2 ahead.

Read together: Apple's engine is good, strong on German, and comparatively weaker on messy
speech and rare terms. Meetings contain both.

What Apple does not provide:

- **Speaker diarization.** No module, no speaker labels.
- **Custom vocabulary on the long-form model.** `contextualStrings` works only with
  `DictationTranscriber`. Names such as "Verity", participant names and project terms cannot be
  boosted on `SpeechTranscriber` today.
- **Configurable compute or open models.** The compute path is fixed; fixes arrive with OS updates.
- **A React Native binding for live audio.** Callstack's `@react-native-ai/apple` exposes
  file-based transcription only. Live microphone streaming needs a small Swift module of our own,
  which fits the existing `apps/mobile/native/` inline-module path.

Behavior on a locked screen is not documented. Because the engine runs in a system process, it is
plausibly not subject to the iOS 27 restriction on background Neural Engine access that applies to
Core ML models inside the app, but this is a hypothesis to test, not a fact.

## 2. Where Verity must add components

| Gap | Options | Assessment |
| --- | --- | --- |
| Speaker diarization | FluidAudio Sortformer or LS-EEND (free, streaming, Apache-2.0 SDK, CC-BY-4.0 / MIT models); Argmax SpeakerKit (MIT, pyannote v4, batch); Argmax Pro SDK (commercial, real-time up to 8 speakers, per-device license validated online every 30 days); sherpa-onnx (Sortformer streaming added September 2026, onnxruntime on CPU) | FluidAudio is the only free, streaming, Neural Engine option. Argmax Pro's license server conflicts with the self-hosted product boundary. sherpa-onnx runs on CPU and is heavier to integrate. |
| Custom vocabulary | `DictationTranscriber` contextual strings (older model); FluidAudio Nemotron decode-time boosting; server-side post-correction of names against the participant list | Accept the gap on the Apple long-form path for V1 and correct names after the fact; revisit if the wake-word experience suffers. |
| Live microphone binding | Own Expo module in Swift feeding `AVAudioEngine` buffers to the analyzer and, in V2, to the diarizer from the same tap | Required on every path. |
| Lock-screen continuity | `audio` background mode plus the engine's own behavior | Must be tested per engine; see the review. |
| Persistence and sync | SQLite write-ahead store and segment-level idempotent queue | Required on every path; missing in the app today. |

## 3. Is FluidAudio the right complement?

For diarization: yes. It is the only free option that streams on the Neural Engine on iOS, and its
limits are documented (Sortformer four speakers, LS-EEND up to ten, error rates around 20 to 30 %).

For transcription it remains a strong candidate rather than the default:

| | Apple `SpeechTranscriber` | FluidAudio Nemotron multilingual streaming |
| --- | --- | --- |
| Download inside the app | None | About 565 MB encoder plus decoder |
| Memory | Outside the app process | Inside the app; iOS 27 attributes Neural Engine memory to the app |
| German quality | Best clean-speech German result in the Dictato benchmark | FLEURS German 9.8 to 10.8 % WER on read speech; Parakeet family stronger on disfluent speech |
| Custom vocabulary | Not on the long-form model | Yes, decode-time boosting |
| True streaming | Yes, volatile and final results | Yes, 560 to 4480 ms chunks |
| Lock screen | Unknown, plausibly unaffected | Requires the iOS 27 background inference entitlement |
| iOS validation | Apple's own engine | Thin; int8 encoder failures reported on A16 and iPadOS 26.5, A17 Pro and M2 unverified |
| Minimum OS | iOS 26 | iOS 17 |
| Maintenance | Closed, fixed by OS updates | Open, five releases in three days, API churn |

## 4. Other alternatives considered

- **WhisperKit (Argmax, MIT, v1.1.0 August 2026).** Mature, Whisper large-v3 turbo at 626 MB,
  the best prompt-based name biasing in the Dictato benchmark. Autoregressive and chunked rather
  than truly streaming, slower and warmer than Parakeet on the Neural Engine, no live diarization
  in the open-source SDK. Not a better fit for an hour-long live meeting.
- **sherpa-onnx (Apache-2.0, React Native TurboModule at v0.4.x).** Broadest model catalog and
  now streaming Sortformer, but no German streaming recognizer (streaming Zipformers exist for
  Chinese, English, French and Korean) and CPU inference through onnxruntime, which costs battery.
  Not better for German live transcription.
- **Cloud streaming APIs.** Deepgram Nova-3 has German streaming with diarization at roughly
  1.31 USD per hour; AssemblyAI and Speechmatics offer streaming diarization, Speechmatics also
  on-premise. These give the best combined transcription-plus-diarization quality with the least
  native engineering, but they send the whole meeting off the device, require a network for the
  entire session, and lie outside the self-hosted core. Verity's existing OpenAI-compatible
  transcription setting is a batch endpoint, not a streaming one. Reasonable as an optional
  server-side backend later, not as the default.
- **Argmax Pro SDK.** Real-time speaker recognition up to eight speakers and Qwen3-ASR in 30
  languages, on device. Commercial per-device pricing and a license server that every device must
  reach at least every 30 days. Incompatible with a fully self-hosted deployment.

## 5. Recommendation

1. **Transcription engine interface with two implementations.** Apple `SpeechTranscriber` as the
   first implementation for V1: no download, no app memory cost, German quality evidence, designed
   for long sessions. FluidAudio Nemotron as the second implementation, kept for devices or locales
   where Apple is unavailable and as the candidate if the benchmark shows Apple losing on
   conversational meeting speech.
2. **FluidAudio for diarization in V2**, fed from the same audio tap, with Sortformer for up to four
   speakers and LS-EEND for larger groups, and the speaker limit shown to the person.
3. **One benchmark before V1 commits.** The same German meeting recordings on the iPhone 15 Pro
   and the M2 iPad Pro through both engines: WER overall and on names and project terms, delay
   behind speech, memory, heat over 60 minutes, and behavior on lock. Decide by measurement.
4. **Names and "Verity" on the Apple path.** Tolerant matching of name variants plus the Ask
   button, and post-correction of participant names on the server. Revisit
   `DictationTranscriber` or the FluidAudio path only if this proves inadequate.

This changes the concept's stated direction from "FluidAudio for transcription in V1" to
"Apple first for transcription, FluidAudio for diarization, FluidAudio transcription as the
measured alternative". The reasons are the iOS 27 background Neural Engine restriction, the in-app
model footprint, the thin iOS validation of the German streaming path, and the German quality
evidence for Apple's engine.

## 6. Sources

- [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer), [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber), [DictationTranscriber](https://developer.apple.com/documentation/speech/dictationtranscriber), [AnalysisContext.contextualStrings](https://developer.apple.com/documentation/speech/analysiscontext/contextualstrings), [SpeechTranscriber.Preset](https://developer.apple.com/documentation/speech/speechtranscriber/preset), [supportedLocales](https://developer.apple.com/documentation/speech/speechtranscriber/supportedlocales)
- [WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/)
- [Apple SpeechAnalyzer vs Whisper, LoroNote, locale list](https://loronote.com/en/blog/apple-speechanalyzer-vs-whisper)
- [Dictato engine comparison, April 2026](https://dicta.to/blog/speech-to-text-engine-comparison-mac-2026/)
- [Argmax: Apple SpeechAnalyzer and WhisperKit, June 2025](https://www.argmaxinc.com/blog/apple-and-argmax)
- [Callstack: SpeechAnalyzer with the AI SDK](https://www.callstack.com/blog/on-device-speech-transcription-with-apple-speechanalyzer)
- [WhisperKit](https://github.com/argmaxinc/WhisperKit), [Argmax Pro SDK 3](https://www.argmaxinc.com/blog/argmax-sdk-3), [Argmax pricing](https://www.argmaxinc.com/pricing)
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), [react-native-sherpa-onnx](https://github.com/XDcobra/react-native-sherpa-onnx)
- [Deepgram Nova-3 German](https://deepgram.com/learn/deepgram-expands-nova-3-with-german-dutch-swedish-and-danish-support), [AssemblyAI real-time overview](https://www.assemblyai.com/blog/best-api-models-for-real-time-speech-recognition-and-transcription)
- FluidAudio references as listed in the concept review
