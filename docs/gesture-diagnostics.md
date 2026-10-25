# Overview gesture diagnostics

Settings → Diagnostics → Record interaction diagnostics records how session rows in
the overview react to touches. It is off on every launch, is never persisted,
and discards what it collected when switched off. A restart ends recording.
While it is off, no observer is attached and no event is collected.

Settings → Diagnostics → Export app update logs includes the recording as
`gestureDiagnostics`: at most the latest 300 events, with `dropped` counting the
older ones that were discarded. Session IDs, titles and branch names are
excluded. Rows are identified by an opaque `row` number that is stable for one
recording, and labelled with their `projectKind` (`local`, `github`, …).

## Events

- `source: row` — an observer on each session row that never activates.
  `touch-down` reports the row width. `locked` and `unlocked` mark the row
  ignoring touches while a drag runs; a locked row receives no touches at all.
  `move-6`, `move-12`, `move-24` and `move-48` mark the distance the finger
  travelled, with `dx`/`dy`. The swipe activates past 12 pt horizontally.
  `touch-cancelled` means another gesture claimed the touch; `touch-up` means
  the finger lifted with no gesture taking over.
- `source: swipe` — the row's swipe actions. `open-start-drag` means the swipe
  activated; `will-open` and `close` follow its outcome.
- `source: reorder` — the long-press reorder gesture over the list.
  `touch-down-hold` means it kept the touch, waiting for the hold, on the given
  `row` (`target` is `session` or `project`). `touch-down-fail` means it let the
  touch go at once, `excluded` meaning the touch was on a link or marker area.
  `start` and `finalize` report a drag pickup and its end.

## Reproduction

1. Install a client build or OTA update containing this instrumentation.
2. Open Settings → Diagnostics and switch on Record interaction diagnostics.
3. Swipe one session row in each project kind being compared, once to the left
   and once to the right.
4. Export the app update logs right away, then switch recording off.

The observer exists only while recording. Switching recording on or off
remounts the overview's session rows, and the observer adds a gesture
recognizer to each row. A fault that disappears while recording therefore
narrows the cause to row mounting or gesture arbitration, without telling the
two apart.


## Runtime responsiveness

The same switch also enables `runtimeDiagnostics` in the existing app-update
export (report schema 6). Enable it while the app is responsive, use the app
normally, then export while it feels slow, before restarting. Switching recording
off discards the samples; restarting starts with recording off.

The export keeps the initial foreground sample and up to 120 recent samples,
collected every five seconds (roughly ten minutes). `dropped` includes samples
removed by the rolling limit or the overall export size budget. The initial
baseline survives both limits. Background/inactive periods suspend sampling;
returning to the foreground starts a fresh timer deadline.

- `runtimeAgeMs` starts at JS diagnostic module initialization, not native process
  launch; `recordingAgeMs` includes time spent in the background.
- `timerLagMs` measures late delivery of the five-second JS timer. It is neither
  CPU utilization nor physical touch-to-paint latency. Initial/resume samples
  use zero; the sample interval is too coarse to detect every short stall.
- `screen` is only `overview`, `session`, `settings`, or `other`. The iPad split
  view counts as overview even when it contains a chat. Paths and IDs are not saved.
- Subscription counts describe logical session streams, including reconnecting
  streams, excluding paused/ended/stopped streams. They are not native socket or
  garbage-collection counts. `sessionStreamsCreated` is cumulative, not active.
- Event counters are cumulative socket deliveries, including replay. Accepted
  events exclude duplicate sequences but may include suppressed output. REST
  history is excluded. Compare counter differences between samples.
- API counters cover client fetch invocation through response headers or failure,
  including transport admission waits. Body decoding and non-client requests are
  excluded. Failures include non-success HTTP responses and rejected fetches.

Counters are scalar process-local values; sampling retains no transcript, URL,
session ID, or request payload and sends no diagnostic network requests. Existing
build/update identity fields identify the loaded client. A rising subscription
count or timer lag is evidence for investigation, not proof of a resource leak.

Schema 5 adds `apiRequestGroups`: fixed `overview`, `preview`, `session`, and
`other` groups. Overview covers list and provider-limit GETs; preview covers
public/local share, detected dev-server and managed dev-server GETs; session covers detail, history and
activity GETs. Mutations and remaining routes belong to other. No request paths,
query values or identifiers are retained. Each group reports cumulative
`started`, `settled`, `failures`, current `inFlight`, and interval `peakInFlight`.
`apiRequestPeakInFlight` is the combined interval peak, not the sum of group
peaks. Peaks reset after each sample and on recording/foreground entry, beginning
with already in-flight requests. These counters end at response headers or fetch
failure; they do not measure body parsing, rendering or native network concurrency.

For embedded session switches, `deferred-pane-effect`, `deferred-pane-first-frame`,
`deferred-pane-second-frame`, `deferred-pane-ready-dispatch` and
`deferred-pane-ready-commit` separate the deferred mount's scheduling steps. They
use the switch's JS clock and do not establish physical paint completion. Compare
them with selection commit and session render/history request start, rather than
attributing the entire pre-request gap to network latency or either frame callback.

To compare responsiveness, enable recording soon after launch, use session
switching and Settings normally, and export while slow before restarting. Confirm
the delivered app/update identity, then compare request-group deltas and peaks,
JS timer lateness and deferred-pane phases. Device latency and the cause of a
slow interval require this comparison; local lifecycle tests establish only that
unnecessary requests and updates have been removed.


## Request families and native invocation (schema 6)

`apiOtherRequestGroups` partitions the existing `other` group into fixed
`google`, `links`, `models`, and `remaining` counters. Google covers `/google`
and session/project Gmail, Calendar, Contacts and Google Workspace routes;
links covers session links and linked-message approvals; models covers `/models`.
Classification applies to mutations too, but only requests classified as `other`
contribute to these subgroups. They use the same cumulative totals, in-flight
counts and interval peak reset as the parent groups. Subgroup peaks cannot be
summed to obtain simultaneous concurrency. No paths, queries, IDs or contents
are retained. Google here describes Verity API routes, not evidence of a direct
request from the app to Google. Request behavior is unchanged.

`native-dispatch` precedes the native method invocation;
`native-promise-returned` records when that invocation returns its promise,
before awaiting it; `native-return` records JS resumption after settlement.
The latter two include a device wall-clock value for correlation with the same
request ID's existing `nativeEntryWallMs` and `nativeResponseReadyWallMs`.
Elapsed phase times use the switch's monotonic clock. A synchronous throw has
no promise-returned phase. Missing records (including bounded-export omissions)
must not be interpreted as zero-duration intervals.

The dispatch-to-promise interval includes synchronous invocation and any thread
scheduling interruption. Promise-return to native entry describes a scheduling
interval, not proof of continuous JavaScript execution or a specific blocking
callback; native execution may begin before JS records promise return. Wall-clock
adjustments can invalidate cross-clock comparisons. Native entry through response
ready includes native processing and network time, while response ready through
JS return includes result conversion and delivery scheduling. These measurements
do not establish physical touch-to-paint latency.

After separately delivering this JavaScript update, verify the loaded commit and
update ID, enable recording while responsive, and repeat the same session/Settings
sequence shortly after launch and after prolonged use. Export while slow before
restart. Compare subgroup deltas and peaks with timer lateness and correlated
transport phases. This instrumentation needs no new native API; native timings
are available only on builds that already expose them. Do not infer a leak or
choose a scheduling rewrite from request totals alone.


## Scroll diagnostic traffic

Session scroll reports (`POST /sessions/:id/debug/scroll`) are sent only while
interaction diagnostic recording is enabled. Outside recording, no scroll report
payload is built and no scroll diagnostic request is started. While recording,
reports share an app-wide limit of one start per second and one request in flight.
Extra events are dropped, never queued or retried, so server scroll logs are a
sample rather than a complete event sequence. Turning recording off prevents new
reports; an already dispatched request may finish. History loading and scroll
position behavior do not depend on report delivery.
