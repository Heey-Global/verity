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
export (report schema 4). Enable it while the app is responsive, use the app
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
