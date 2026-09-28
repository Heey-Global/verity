# Live Meeting concept review

**Status:** Independent review of [LIVE_MEETING_CONCEPT.md](LIVE_MEETING_CONCEPT.md), 2026-09-28.
**Method:** Vendor documentation, issue trackers, model cards and Apple release notes checked
on the review date, plus a read of the current mobile, server and knowledge code. No device
test was run; every statement about iPhone or iPad behavior below is a documented claim or an
open question, not a measurement.

## 1. Verdict

The product concept holds. Session-bound entry, transcript above notes, minimize bar,
write-ahead persistence and honest sync state are the right core, and nothing in this review
argues for changing them.

Three findings change the engineering plan and should be folded into the concept before V1 starts:

1. **iOS 27 restricts Neural Engine access in the background.** Any Neural Engine inference while
   the app is backgrounded or the screen is locked now requires the entitlement
   `com.apple.developer.background-tasks.continued-processing.inference`, which is tied to
   `BGContinuedProcessingTask`: a Live Activity that the person can cancel and that the system
   may terminate under resource pressure. A one-hour lock-screen meeting on a local Core ML model is
   therefore not an assumption V1 can make. See section 3.
2. **There is no usable React Native wrapper for FluidAudio.** The official
   `@fluidinference/react-native-fluidaudio` is version 0.1.0 from January 2026, legacy bridge only,
   pins FluidAudio `~> 0.7` while upstream is at 0.17.x, and exposes file-based diarization and
   English streaming only. Verity has to write its own Expo module in Swift. The repo already
   compiles Swift inline modules from `apps/mobile/native/`, so this is native work on a known path,
   not a new build system. See section 4.
3. **German real-time transcription in FluidAudio is exactly one model.** Nemotron 3.5 Streaming
   Multilingual 0.6B (the `latin` bundle) is the only true-streaming German option. Parakeet v3, Ultra
   and Redux are sliding-window batch models that stitch roughly 15 s chunks and are "near real-time".
   Upstream has no published iOS validation for the Nemotron path on A17 Pro or M2, and it has
   shipped iOS-specific loading failures on A16 and iPadOS 26.5. See section 5.

The recommendation is not to abandon FluidAudio. It is to keep FluidAudio as the diarization
engine, keep it as the primary transcription candidate, and make the transcription engine
pluggable so that Apple's `SpeechAnalyzer` (iOS 26+) can be benchmarked on the same German
recordings before V1 commits. Section 6 explains why.

## 2. Feasibility on the target devices

| Topic | Finding | Confidence |
| --- | --- | --- |
| Minimum OS | FluidAudio requires iOS 17+; Nemotron `latin` bundles target iOS 17+; the requested devices run system version 27. Apple's `SpeechAnalyzer` requires iOS 26+. | Documented |
| Hardware | iPhone 15 Pro (A17 Pro, 8 GB) and iPad Pro 11-inch 4th gen (M2, 8 or 16 GB). FluidAudio's own iOS notes verify int8 encoders "on M-series only"; the int8 Parakeet Unified encoder fails to load on A16 on every compute unit. A17 Pro and M2 are unverified upstream. | Documented gap |
| Model size | Nemotron `latin/2240ms` encoder weights: 565 MB on disk. Parakeet Ultra int8 encoder: 595 MB. Parakeet Redux: about 220 MB, iOS 18+, "several-minute first compile". Sortformer and LS-EEND are additional bundles. | Documented |
| Memory | iOS 27 attributes Neural Engine memory to the app process. Two resident 0.6B-class models plus audio buffers plus React Native will be measured against an undocumented per-app limit on an 8 GB device. This must be measured, not estimated. | Unknown |
| First-load compile | Parakeet v3 encoder cold compile: 3.4 s on iPhone 16 Pro Max, 4.4 s on iPhone 13. Acceptable if surfaced in the preparation step. | Documented |
| Latency | Nemotron tiers 560/1120/2240/4480 ms chunk size; 2240 ms is the documented default and best accuracy; punctuation degrades on long sessions at 560 ms. Expect text 2 to 3 s behind speech. | Documented |
| German accuracy | Nemotron `latin`: FLEURS de_de 9.8 to 10.8 % WER (read speech, M-series). Real meetings with cross-talk and room acoustics will score worse. No German meeting benchmark exists upstream. | Documented, indicative only |
| Heat and battery | No published iOS streaming measurement from FluidAudio. Hedy and Transkript ship FluidAudio on iPhone, which is an existence proof, not a 60-minute measurement. | Unknown |
| Model download | Bundles are hosted on Hugging Face. FluidAudio supports a registry URL override. An interrupted first download previously left an unloadable cache that was indistinguishable from an incompatible model (issue #819). | Documented |
| Licenses | FluidAudio Apache-2.0. Parakeet v3/Ultra/Redux CC-BY-4.0. Sortformer CoreML CC-BY-4.0 (NVIDIA Open Model License upstream). LS-EEND MIT. Nemotron 3.5 Streaming Multilingual OpenMDW-1.1. All permit commercial use; attribution notices are required and must be added to the third-party notices. | Documented |

What this means for the concept: the iOS 17 floor is fine, the device matrix is exactly the
unverified zone for int8 encoders, and the storage and memory numbers are large enough that model
preparation must be a first-class step with disk-space checks, checksums and repair. The concept
already says so in section 4; it should additionally require self-hosting the model bundles on
the Verity server so that a self-hosted deployment does not depend on Hugging Face availability.

## 3. Background execution is the biggest open risk

Apple's iOS 27 release notes state that the system "now restricts background access to the Neural
Engine, similar to GPU usage restrictions" and that any Neural Engine access while the app is in
the background requires the new Background Inference entitlement. The entitlement works with
`BGContinuedProcessingTask`, introduced in iOS 26, which starts from a person's action in the
foreground, shows progress in a Live Activity, can be cancelled by the person, and "can terminate
abruptly depending on run-time conditions". FluidAudio's maintainers have filed feedback with
Apple about this restriction and asked users to duplicate it.

Consequences:

- **V1 must be specified as foreground-first.** Keep the screen awake while a meeting runs, use the
  `audio` background mode so the microphone session survives short app switches and the lock
  button, and treat continued Neural Engine inference in the background as a separate, gated
  capability. The concept currently lists background capture as a "validation gate"; it should
  say which behavior is promised and which is best-effort.
- **CPU fallback is not a free answer.** LS-EEND is documented as fastest on CPU, so diarization
  could continue without the Neural Engine. A 0.6B transcription encoder on CPU is not documented
  for iOS and would likely be slow and hot. Nemotron's docs say `.all` routes the encoder to the GPU
  and runs about 10x slower than the ANE.
- **Apple's own speech engine may be the way to keep transcription alive while locked.**
  `SpeechAnalyzer` runs Apple's models under Apple's rules; whether it continues under the `audio`
  background mode on iOS 27 is not documented in the pages checked and must be tested. If it does,
  it becomes the natural fallback engine when the app leaves the foreground.
- **Whether the entitlement is granted on request or reviewed by Apple is not stated** in the
  documentation checked. Plan for a request and for a rejection.

The concept's honesty rule already covers this: never claim to recover speech that was not
processed. The addition is that the gap will happen by design on a locked device unless one of
the paths above is proven.

## 4. Integration into the Verity app

Facts from the repository:

- The app is Expo SDK 57 with continuous native generation; `ios/` is generated at build time and
  the New Architecture is enforced (`apps/mobile/app.config.ts:24`).
- Swift inline modules already exist under `apps/mobile/native/` and are compiled by prebuild
  (`apps/mobile/app.config.ts:180-185`). They use `ExpoModulesCore` `Module` definitions. This is
  the path for a meeting capture module.
- There is no mechanism yet for adding a Swift package or an extra pod. FluidAudio ships a podspec;
  a small config plugin that adds the pod and raises the deployment target via
  `expo-build-properties` is needed. No deployment target is configured today.
- `UIBackgroundModes` is not set and nothing in the app uses `AVAudioSession`.
- The signed iOS build runs on a `macos-26` GitHub runner and takes about 30 minutes; native
  changes require a new native minor release because the OTA runtime version is pinned to `X.Y.0`
  (`apps/mobile/app.config.ts:189-194`). `.github/workflows/mobile-native-verify.yml` compiles the
  iOS project for the simulator, which verifies that FluidAudio builds but cannot exercise the
  Neural Engine.
- Local persistence is AsyncStorage and SecureStore only. There is no SQLite. Meeting uploads are
  tracked in an in-memory map (`apps/mobile/lib/meetingUploads.ts:40-62`); the only durable outbox
  is the push quick-reply outbox (`packages/mobile/src/push/outbox.ts`).

Design consequences:

- **Capture, inference and the timeline merge belong in the native module**, not in JavaScript.
  JavaScript should receive events with finalized and volatile segments and speaker turns. Feeding
  16 kHz PCM through the bridge as base64, as the official wrapper does, is the wrong shape for a
  one-hour session.
- **Write-ahead persistence needs a real store.** AsyncStorage is a single-file key-value store and
  not suited to appending thousands of segments. Add `expo-sqlite` (or write from Swift) and
  persist every finalized segment and note before it is rendered. The concept's durability
  section is right; the repo does not yet have the primitive it assumes.
- **The durable sync queue does not exist yet either.** The push outbox is the closest pattern;
  the meeting queue needs segment-level idempotency, not one request id per upload.
- **A native crash ends the app.** Core ML runs in-process on iOS, and FluidAudio's tracker shows
  platform-level crashes in Apple's BNNS path on specific OS builds (macOS 14, iOS 26.4 to 26.5,
  iOS 27.0 for the Kokoro TTS route). Those are not our models, but they are the crash class that
  no JavaScript error boundary can catch. The loss budget must be stated as "at most the audio
  since the last finalized segment plus the time until relaunch", and relaunch must detect an
  unfinished meeting and mark the gap.
- **Microphone ownership** must be arbitrated between the meeting module and
  `expo-speech-recognition` dictation; both want the audio session.

## 5. Transcription and speaker recognition core

### Transcription

Nemotron 3.5 Streaming Multilingual is a serious model: cache-aware RNN-T, confirmed and volatile
output, custom vocabulary via decode-time shallow fusion (which is how "Verity" and participant
names would be boosted), German included in the `latin` bundle. The concerns are not quality on
paper but validation depth:

- Issue #739 reported zero output on a cold start on iPadOS 26.5 (M1) for the English Nemotron int8
  model, fixed upstream afterwards; issue #828 reported int8 encoders failing to load on A16 with
  fp16 as the workaround. The library moves fast (five releases between 2026-09-23 and
  2026-09-25), which is good for fixes and bad for API stability. Pin a version and re-validate on
  every bump.
- The documentation contradicts itself on distribution: one page says the multilingual model is
  "local-path-only, convert it yourself (Linux + CUDA)", while the model overview and the Hugging
  Face repository show published bundles per language and tier. The published bundles are real;
  the point is that documentation cannot be trusted without checking.
- Streaming RNN-T emits tokens as they are decoded. Whether the Swift API exposes per-word
  timestamps precise enough to cut a segment at a speaker change inside a 2 s chunk must be
  verified. If it does not, speaker attribution in V2 will be chunk-granular at turn boundaries.

### Speaker recognition

FluidAudio's own documentation sets the expectation, and the concept should repeat it to the person
using Verity:

| Diarizer | Max speakers | Documented accuracy | Behavior |
| --- | --- | --- | --- |
| Sortformer | 4, hard limit | About 32 % DER described as "representative of production" on meetings | Very stable identities, misses quiet speech, 480 ms updates, no memory across recordings |
| LS-EEND `.ami` | 4 | 20.76 % DER on AMI | Conference-room tuned |
| LS-EEND `.dihard3` | 10 | 19.61 % DER on DIHARD III | General purpose default, more false alarms, 8 kHz input, CPU-fast, "handles recordings up to one hour" |

A diarization error rate of 20 to 30 % means that roughly one in four or five seconds of speech is
attributed wrongly or missed. That is normal for the field and acceptable for a product only if
correction is cheap, which the concept provides. Two gaps:

- **Speaker count.** A five-person meeting breaks Sortformer silently by merging speakers. LS-EEND
  `.dihard3` covers up to ten but is less stable. Choose per meeting or expose the limit. The
  concept should state the supported speaker count.
- **Meeting length.** LS-EEND documents one hour. The concept targets one hour and should plan for
  longer: define what happens at a state reset (identities restart, names must be re-attached by
  the person) or prefer Sortformer's speaker cache for long sessions.

"Stable speaker recognition" is therefore achievable in the sense of stable labels for up to four
people in a quiet room, with visible correction. It is not achievable as an unsupervised
guarantee, and the concept is right not to promise cross-meeting identification.

## 6. Is FluidAudio the right decision?

For **diarization**: yes. Apple offers no on-device diarizer, and FluidAudio has three streaming
diarizers with published limits and permissive licenses.

For **transcription**: it is a defensible primary choice, but not yet a decision that should be
locked before a measurement, for three reasons that did not exist when the direction was chosen:

1. Apple's `SpeechAnalyzer` and `SpeechTranscriber` (iOS 26+) are designed for long-form,
   on-device transcription with volatile and finalized results, system-managed language assets and
   no 565 MB download inside our app. They are not exposed by `expo-speech-recognition`, so they
   also need native code, but that code is small. German support and quality must be checked on
   the device via `supportedLocales`.
2. The iOS 27 background restriction applies to our Core ML models. Apple's engine is the only
   candidate that may keep transcribing on a locked screen without the new entitlement.
3. Upstream iOS validation for the German streaming path is thin, and the target devices are
   exactly the unverified chips.

Recommended decision rule: build the capture module with an engine interface and two
implementations, run both on the same German meeting recordings on both devices, and choose per
metric: word error rate on names and project terms, delay behind speech, memory, heat, and
behavior on lock. If FluidAudio wins or ties on quality and the background question has an answer,
V1 ships FluidAudio. If Apple wins on lock-screen continuity, V1 ships Apple for transcription and
FluidAudio for diarization in V2, which is the split the earlier discussion considered.

WhisperKit and other Core ML speech ports were not evaluated in this review.

## 7. The meeting assistant

Facts from the repository that shape this:

- One-shot model calls exist through `conductor.query`
  (`packages/session/src/conductor.ts:1633-1656`), routed to the configured agent CLI; there is no
  direct Anthropic or OpenAI SDK dependency.
- Web search exists only inside agent sessions through the agent CLI's own tools. There is no
  server-side search API.
- There is no search index over `/knowledge`. Agents read the folder with `ls`, `grep` and `cat`
  (`docs/knowledge.md:34-36`). Meeting sources are stored as Markdown with
  `**Speaker** (mm:ss): text` lines and no structured sidecar.
- Periodic server work follows the agent loop scheduler pattern; there is no generic durable job
  queue, and in-flight transcriptions are tracked in memory only.

Assessment per mode:

**On request** is feasible with the existing building blocks and should come first. The device
already has to sync finalized segments for durability; the server can hold a meeting-bound agent
session that receives transcript deltas as context, answers "Ask Verity" questions with knowledge
folder access and the agent's web search, and posts a card back. Expect 5 to 20 s for an answer
that needs research; the card must show progress. Direct address by name should be detected on the
device with vocabulary boosting plus tolerant matching, and the Ask button remains the reliable
path.

**Auto** is the genuinely uncertain part, in product terms rather than technical ones. The
mechanism is a periodic triage over newly finalized speech, escalating to research only for
decision-relevant, checkable claims. Three things must be true for it to be worth having:

- Triage must be cheap and frequent: roughly one small-model call per 30 to 60 s of speech, so 60
  to 120 calls per hour plus a handful of research runs. Budget and rate caps belong in the design,
  not in a later tuning pass.
- Precision must be high. A wrong or stale "contradiction" card during a meeting costs more trust
  than a missed one. Every card needs a source path and date, and "could not verify" must never
  render as "the participant is wrong". The concept says this; the review agrees and adds that
  Auto should be evaluated offline on recorded meetings before it is enabled live.
- Contradiction detection against the knowledge base requires retrieval that does not exist yet.
  With no index, each triage would grep the project folder or rely on the agent's own file search.
  That works for small projects and degrades with size. A lightweight full-text index over
  `/knowledge` sources is a prerequisite for Auto, not for On request.

Architecture recommendation: do not build a new LLM client. Bind one agent session per meeting on
the server, feed it transcript deltas, give it the knowledge folder and web search it already has,
and run Auto as a scheduled triage turn in that same session. That keeps research inside the
self-hosted boundary, reuses provider configuration, and makes cost visible per meeting. Because
the assistant runs server-side, iOS background restrictions do not affect it; the device only has
to keep syncing.

Privacy boundary to state clearly: transcript segments leave the device for the Verity server in
every mode, because durability and knowledge export require it. What "Off" turns off is submission
to the configured model provider and any name-triggered action.

## 8. Reliability posture

"Cannot crash" is not a property this design can have. What it can have:

- **A stated loss budget.** At most the speech since the last finalized segment plus the relaunch
  gap, with the gap visible in the transcript.
- **Write-ahead persistence in SQLite** for segments and notes, written before render.
- **Relaunch recovery** that detects an unfinished meeting, marks the gap and offers to resume.
- **Degradation ladder** driven by memory warnings and thermal state: drop diarization first, then
  raise the chunk size, then fall back to the alternate transcription engine, then stop with a
  visible state. Never degrade silently.
- **Model preparation as a gate** with checksum validation, partial-download repair and disk-space
  checks, and self-hosted bundles.
- **Audio session handling** for calls, route changes and dictation conflicts.
- **An opt-in retained audio buffer.** The concept deliberately omits an audio archive. Given that
  the crash class above cannot be caught in JavaScript and that a locked screen may stop inference
  by design, a rolling on-device audio file that is deleted at meeting end unless the person keeps
  it is the only way to recover a gap after the fact. This review recommends offering it as an
  opt-in, default off if the product decision stands, and default on during the device test phase.

## 9. Concrete changes to the concept

1. Section 3 and 4: replace "background capture is a validation gate" with a stated foreground-first
   promise, the `audio` background mode for microphone continuity, and a separately gated
   "continue on lock screen" capability that names the iOS 27 entitlement and its Live Activity
   behavior.
2. Section 1 and 4: keep FluidAudio as the primary transcription candidate but require the engine
   interface and the side-by-side German benchmark against Apple `SpeechAnalyzer` before V1 commits.
3. Section 4: name the persistence primitive (`expo-sqlite` or native) and the segment-level
   idempotent sync queue as new work; note that the repo has neither.
4. Section 4: require self-hosted model bundles with checksums and a repair path.
5. Section 5: state the supported speaker count per diarizer and the behavior after one hour.
6. Section 7: order the assistant as On request first, Auto behind a flag with per-meeting caps,
   agent-session architecture, and a knowledge full-text index as an Auto prerequisite.
7. Section 8: add iOS 27 specific gates: int8 encoder load on A17 Pro and M2, Neural Engine memory
   attribution, behavior on lock with and without the entitlement, and a 60-minute soak with
   transcription and diarization resident at the same time.
8. Section 9: add license attribution to the third-party notices as an implementation task.
9. Decide on the opt-in retained audio buffer.

## 10. Sources checked

- [iOS and iPadOS 27 release notes, Core AI and Neural Engine](https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27-release-notes)
- [Background Inference entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.background-tasks.continued-processing.inference)
- [BGContinuedProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask)
- [AVAudioSession record category and background audio](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/record)
- [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer) and [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber)
- [FluidAudio README and showcase](https://github.com/FluidInference/FluidAudio)
- [FluidAudio model overview](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Models.md)
- [Nemotron multilingual streaming documentation](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/ASR/NemotronMultilingual.md) and [model card](https://huggingface.co/FluidInference/Nemotron-3.5-ASR-Streaming-Multilingual-0.6b-CoreML)
- [Diarization guide](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/GettingStarted.md), [Sortformer](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/Sortformer.md), [LS-EEND](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/LS-EEND.md)
- FluidAudio issues [#738](https://github.com/FluidInference/FluidAudio/issues/738), [#739](https://github.com/FluidInference/FluidAudio/issues/739), [#819](https://github.com/FluidInference/FluidAudio/issues/819), [#828](https://github.com/FluidInference/FluidAudio/issues/828)
- [react-native-fluidaudio](https://github.com/FluidInference/react-native-fluidaudio)
- Repository: `apps/mobile/app.config.ts`, `apps/mobile/native/`, `apps/mobile/lib/meetingUploads.ts`, `packages/mobile/src/push/outbox.ts`, `packages/session/src/conductor.ts`, `packages/server/src/meeting-transcript-routes.ts`, `docs/knowledge.md`, `docs/mobile-build-performance.md`, `.github/workflows/mobile-native-verify.yml`
