# Native request start and device verification

Schema 7 adds a dedicated native start path for interactive GETs of session details,
events and bounded history. It is selected by native capability, independently of
whether a gesture diagnostic is recording. Other requests retain their existing path.
There is no experiment switch and no error-triggered downgrade from V3 to V2/V1.
Existing direct/Uplink read recovery still applies; TLS pins, route selection,
HTTP lane partitioning and response decoding are unchanged.

## Native boundary

The Swift `async` overload of Expo `AsyncFunction` schedules its body through the
JS runtime before native entry. `requestV3` instead uses the non-async Swift
closure with an explicit Expo Promise and `runOnQueue` on a dedicated serial
start queue. Each queue block only launches an asynchronous Task, allowing the
history and detail requests to overlap. Response conversion and promise delivery
still happen through Expo on the JS runtime; this change cannot guarantee that a
busy JS runtime will deliver results promptly.

The JS wrapper synchronously reserves a bounded request owner before queueing.
Cancellation is synchronous and removes/cancels that owner, including before the
queue block starts. Native shutdown closes the reservation registry and cancels
its owners. Task installation/resume is serialized with cancellation. Every queue
block either rejects a missing owner once or launches one Task that resolves or
rejects once; cleanup compares owner identity so a late completion cannot remove
a replacement. Synchronous bridge failures also release their reservation. JS
rejects an aborted response even if native already submitted a success.

Older native builds do not advertise the complete prepare/request/cancel trio and
continue using V2 or V1. An OTA alone cannot provide the new native entry path.

## Diagnostic interpretation

- `native-queued-start` confirms that a correlated request selected V3.
- `nativeEntryWallMs` is sampled on entry to the native queue block for V3.
- `nativeWorkEntryWallMs` records entry to the asynchronous request implementation.
- `nativeResponseReadyWallMs` records completion of native response construction.
- `nativePromiseResolveWallMs` records submission to Expo's promise resolve/reject
  API, **not** execution of JS conversion or the JS promise continuation.
- `native-return` carries the JS wall timestamp after awaiting the native promise.
- `restore-path-latest`, `restore-path-outside-tail` and `restore-path-anchor`
  identify scroll restoration choices without recording positions or contents.
- `restore-scheduled`, `restore-start` (0 = interaction completion, 1 = timeout
  fallback), `restore-step` (0–4), `restore-settle` and `restore-timeout` locate
  restoration scheduling and completion. Existing readiness signals are distinct:
  FlashList `onLoad` is not proof that a restoration cover has disappeared.

All additions use existing bounded, content-free trace/metric exports. Compare
matching opaque request IDs using device wall timestamps, not server timestamps.
Timer lateness is not proof of continuous JS execution; in-place aggregate values
can describe a later peak than the phase's original elapsed timestamp.

## Verification and delivery

Local JS tests cover capability fallback, eligibility, reservation ordering,
pre-abort, cancellation while pending, late success, and synchronous/asynchronous
failure without V2 replay. Native source guards verify the intended Expo overload;
they do not substitute for compilation. The existing Apple TLS/pool smoke fixture
also exercises reservation bounds, stale-owner cleanup, shutdown, pre-install
cancellation and active task cancellation with production lifecycle code.

Before delivery, the macOS native workflow must compile the actual Expo module
and run the Apple TLS/pool smoke tests. Linux cannot validate Expo/Apple Swift
compilation or device scheduling. No merge or release is implied by this PR.

After a new staging native build is delivered:

1. Export diagnostics and confirm native build/runtime, OTA commit/update ID,
   schema 7 and `native-queued-start`; retain the identities with every capture.
2. Repeat at least 20 session switches on the same iPad, pairing and network,
   including cold/warm opens, quick switches and a session with a saved anchor.
3. Compare the JS-to-native entry gap, native work/network duration, native-ready
   to JS-return gap, and both list-loaded and transcript-ready milestones.
4. Compare median and slowest cases with the existing build-29 capture; record
   failures and cancellations as well. Different builds can contain other changes,
   so a before/after improvement alone cannot isolate this change's causal effect.
5. Verify cancellation when leaving, latest-edge and saved-position restoration,
   visible Google status, links and approvals. A faster native entry alone does
   not establish faster visible interaction.

The supplied build-29 capture has a 3293.8 ms promise-return-to-native-entry gap
for switch 17's first history request, followed by 70.5 ms native work and 551.7 ms
until JS return. Switch 10 has a 2402.9 ms native-ready-to-JS gap. These locate
waiting intervals; the responsible workload and the new build's improvement remain
unproven until device verification.

### Selection scheduling probes

With **Record interaction diagnostics** enabled, gesture events with source
`scheduling` record sidebar/session layout and passive effects, followed by
microtask and zero-delay timer callback waits (`waitMs`). These are scheduling
boundaries, not measurements of continuous JS blockage or paint. The fixed
Profiler boundaries also emit `*-react-profile` with React's durations and
start/commit timestamps when the React build supports profiling. Standard
production builds may emit no profiler callbacks; their absence is not zero
render cost. Recording does not change the boundary tree or gesture behavior.

Row touch-down/up/cancel events additionally carry `uiReceivedWallMs` captured
in the UI worklet and `jsReceivedWallMs` at JS delivery. Their difference helps
locate delayed bridge delivery. The UI timestamp is recognizer callback time,
not hardware touch receipt; wall-clock adjustments can invalidate the difference.
Native React touch timestamps in switch phases use a separate clock and must
not be subtracted from these wall timestamps. Existing event limits, dropped
counts, recording reset and export size limits apply to these probes.

### Diagnostic retention (schema 8)

The 300-event gesture buffer admits at most 60 raw scheduling events. A new
scheduling probe cannot evict a touch, swipe or reorder event; when the buffer
is full, interaction events evict scheduling entries first. A bounded summary
for each of the ten fixed scheduling probe names retains its count, first/last
wall timestamp, maximum wait and its wall timestamp, and maximum React actual
render duration when available. Summaries cover the current recording even
when raw events are omitted, and reset with the recording. They do not replace
a chronological profile or identify a blocking function. `dropped` counts raw
events omitted, including entries whose measurements remain in a summary.

The shared report still has a 256 KiB UTF-8 ceiling, reserving half for update
and recovery logs. Under pressure it removes raw scheduling events first,
then older runtime samples (keeping the separate baseline and latest sample),
then native records unrelated to retained switch requests, then remaining
native records, then older switch traces, and finally interaction events.
The latest switch and scheduling summaries remain. Every removed record updates
its stream's omission count. Export pruning operates on snapshots and does not
drain the live recording. This prioritizes selection evidence without promising
that an arbitrarily crowded capture can retain every switch or native metric.
