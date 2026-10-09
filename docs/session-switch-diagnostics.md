# Session switch timing diagnostics

Settings → Diagnostics → Export app update logs includes `sessionSwitchTimings`.
The export identifies the running release, native build, stamped JavaScript commit,
OTA update ID and runtime/channel. Timings are held only in memory: export them
before restarting the app. No new diagnostic network requests are sent.

The buffer retains the last eight row gestures, at most 64 lifecycle phases plus 64 aggregate/probe phases per gesture,
and collects for at most 30 seconds. Each switch has an opaque `switchId`, a wall
clock `at` for approximate correlation, and monotonic `elapsedMs` values. Session
IDs, titles, URLs, message text, credentials and response bodies are excluded.
Rapid switches supersede earlier gestures; late callbacks cannot add phases to
a replacement gesture, even when returning to the same session. Cancelled
touches are recorded. A touch without `js-press-handler` may be a scroll or long
press rather than a session selection. Keyboard/accessibility presses can begin
with `js-press-handler` and have no touch phase. Collection limits can truncate
long/repeated loads; `droppedPhases` reports rejected entries. `readiness` states
whether the list load notification was recorded, not whether a frame was visible.
Aggregate metrics have an independent budget so they cannot displace lifecycle
completion. Absence of a phase alone does not prove a stage never ran.

## Interpreting phases

- `js-touch-start` is callback entry in JavaScript. Its optional `value` is the
  native event timestamp, in a separate clock domain. It is not a measured
  physical tap time, and must not be subtracted from `elapsedMs`.
- `js-press-in` and `js-press-handler` expose the interval before selection.
  `selection-dispatch` or `link-navigation-dispatch` records selection/navigation
  intent; `selected-row-react-commit` and `session-screen-react-commit` record
  effect execution after React commits, not pixels appearing on screen.
- `session-*` and `events-*` request phases distinguish fetch start/return,
  response body consumption, synchronous JSON parsing and schema validation.
  Fetch return behavior depends on the transport; it is not guaranteed to be
  receipt of headers only. Body read may include remaining transfer and decoding.
- `history-page-reduce-*`, `history-install-*` and
  `loaded-model-state-react-dispatch` distinguish message probing, reducer seed
  installation and the animation-frame-batched React state dispatch.
- `replay-subscribe`, `replay-caught-up` and `history-fallback-replay` expose
  stream catch-up and REST failure fallback. They do not record message content.
- `anchor-read-*` brackets the AsyncStorage read and anchor parsing. It does not
  measure persistence writes or prove that storage causes the delay.
- `flash-list-on-load` is the list's load notification;
  `transcript-ready-react-commit` records loaded rows with restoration released.
  Neither is a native paint/presentation measurement.

## Bounded reproduction

1. Install a compatible client build/OTA bundle containing this instrumentation.
   Confirm its commit or update ID in the exported report; marketing version
   alone is insufficient. A server update is not required.
2. Switch between the same two sessions three times, allowing each to finish.
   Export immediately through Settings → Diagnostics. If useful, repeat once
   with rapid switches to distinguish superseded callbacks.
3. Compare adjacent phase timestamps within each switch, then correlate its wall
   clock with server request durations. Do not subtract server and client clocks
   to infer network delay. Separate initial history pages from later prefetch.
4. Use an external recording or native profiling for tap-to-first-visible-frame
   and input delivery before JavaScript. A blocked JS thread can delay the first
   callback, and React/list callbacks cannot establish actual native paint.

This is JavaScript-only instrumentation. Deliver through the existing approved
mobile release path for the device's compatible runtime. An iPad on runtime
1.60.0 needs a compatible 1.60.x OTA containing these changes, or an appropriate
native build; an update for runtime 1.59.0 cannot reach it. Publishing, promotion
and installation remain separate from local implementation and verification.

## Allow approval timing

The same bounded buffer includes gestures on Allow and scoped Allow buttons.
`kind: permission` distinguishes these from session selection. No tool name,
secret alias, scope, tool-use ID, request body or response body is exported.
`allow-js-touch-start`, `allow-js-press-in`, `allow-js-press-handler`,
`allow-model-handler`, `allow-spinner-react-commit`, `allow-request-start`,
`allow-fetch-return`, `allow-response-processed` and `allow-model-response`
distinguish input handling, busy-state rendering and server completion. The
spinner commit is not a native paint measurement. A fast response may finish
before React commits the spinner. A cancelled touch has no approval handler;
rapid subsequent gestures supersede the earlier trace. Allow traces share the
eight-entry limit with session switches. Reproduce a delayed Allow action and
export immediately, before restarting the app.

## Initial publication and render entry

The first loaded model snapshot is dispatched immediately; subsequent streaming
snapshots remain animation-frame batched. `loaded-model-state-publish` precedes
that immediate dispatch, without promising synchronous React rendering.
`selection-home-render-entry` and `session-screen-render-entry` record only the
first render entry for the active gesture. They can include an interrupted render
that never commits. The interval to the existing React effect markers includes
rendering, child work, scheduling and effect execution; it is not isolated CPU
render time or native paint. These markers share the existing collection limits.


Render work aggregates (`render-<stage>-total-ms` and `render-<stage>-count`)
measure synchronous work in the home body, sidebar group/row bodies, chat body,
transcript row reconciliation and list-item element construction. Each pair takes
two phase entries regardless of render count. `value` holds the cumulative duration
in milliseconds or invocation count; `elapsedMs` is the first recorded sample's
completion time, not the aggregate duration. Collection stops at the first
`flash-list-on-load` or the existing 30-second trace limit. List completion is
tracked independently, so a full phase buffer cannot prolong collection.

Component-body intervals end before their return expression and exclude rendering
of descendants, native layout and paint. List-item construction measures creation
of React elements, not execution of their child components. Chat-body time includes
transcript reconciliation, so these totals overlap and must not be added together.
Interrupted attempts are included; renders that throw before reaching their end
marker are not. Compare these totals with the entry/effect intervals to distinguish
measured synchronous work from unmeasured child work and scheduling. This uses
ordinary JavaScript clocks and works without a React profiling build.

Automatic history pagination waits for the initial list's `onLoad` signal. Explicit
message jumps can still load required pages before that signal. Saved-anchor
restoration is unchanged: anchors outside the loaded tail fall back to latest. Verify on a device by opening a long session at the newest edge: automatic
follow-up `events-request-start` should follow `flash-list-on-load`, and scrolling
backwards should continue loading history. Also verify a deep saved anchor and an
explicit message jump. Only explicit jumps may legitimately request earlier pages.

### Thread scheduling probes

`js-timer-lag-max-ms` records the maximum lateness of a 100 ms JavaScript timer
from the row touch callback. Each callback schedules a fresh one-shot timer;
interval catch-up behavior cannot inflate a later sample. It includes timer
scheduling and garbage collection and does not identify the blocking function or
prove continuous JS blockage. Other JS work can execute while a timer is overdue.
`js-timer-peak-deadline-ms` and `js-timer-peak-observed-ms` contain the peak interval
endpoints in `value`, relative to switch start. Their `elapsedMs` remains the
first insertion time because aggregates are updated in place.

At list completion, `js-timer-pending-at-list-load-ms` records how overdue the
pending timer is. It is not an observed timer callback and does not update the
callback maximum. This distinguishes timer starvation from measured callbacks.
Fetch-return and AsyncStorage promise continuation similarly include JS delivery
latency; they cannot alone isolate network or native storage duration.

 `ui-frame-gap-max-ms` records maximum
Reanimated UI-thread frame callback spacing from chat mount; reporting crosses
to JavaScript at most twice per second. Its phase timestamp is report delivery,
not the time of the delayed frame. Neither probe proves native paint completion.
Both stop after initial list completion, supersession, backgrounding or ten
seconds. Backgrounding ends collection rather than counting the suspended time.
The UI probe cannot cover the interval before the chat mounts.

`render-transcript-row-body` measures the synchronous row content factory;
`render-markdown-body` includes Markdown parsing and element creation. Descendant
components and native text layout remain outside these body measurements.

### Correlated transport measurement

Each timed session/detail or events request gets an opaque
`x-verity-switch-request` token plus a fixed `x-verity-switch-kind`. The token
contains no session identifier and grants no authority. `transportRequests`
retains at most 16 requests per gesture and 24 milestones per request for the
30-second trace window. `transportOmissions` counts rejected requests/milestones. Late callbacks stay on their original gesture. Retries
share the logical request token and add separate native attempts.

Client milestones distinguish fetch dispatch, pinned transport entry, body
encoding, route readiness, native dispatch/return and fetch return/error. Route
milestone values are 0 for direct and 1 for tunnel. The `native-return` value is
the device wall timestamp at JS continuation, not a server timestamp.

`nativeTransportTimings` reports capability availability, up to 32 attempts and
an omission count. Older installed native builds report `available: false`;
OTA JavaScript alone cannot add this native capability. Native records contain
entry, resume, completion and response-ready times, route/proxy dialect and up
to four URLSession transactions. Transactions expose DNS, connection, TLS,
request and response milestones, protocol and reuse. `metricsAvailable: false`
means metrics had not arrived; export snapshots also capture later metrics
without delaying the HTTP response. No URLs, headers or payloads are retained.

Read native intervals within their own clock domain. Resume to request start
includes scheduling and connection setup; it is not proof of a connection queue.
Completion to response-ready includes native conversion and continuation work.
Response-ready wall time to the JS continuation can help identify bridge delivery
latency, but a device clock adjustment invalidates that wall-clock difference.
Do not subtract device and server wall times without clock calibration.

The managed gateway emits one `session-switch-http` record per admitted
request with the same token, arrival wall time and monotonic offsets for forward,
socket assignment, upstream request finish, response headers/end and downstream
completion. Core records arrival and completion/abort/timeout with that token; completion uses
its own monotonic elapsed time. Gateway and Core each
limit these diagnostics to 120 requests per minute in constant memory. Missing
records can mean a budget limit, maintenance rejection, an older server or a route
that bypasses the gateway; absence alone does not establish transport failure.
These records do not log session paths or raw request headers.

For a device verification, install a native client containing the transport API
and deploy the instrumented gateway/Core through their approved release workflows.
Switch between the same sessions, export before restart, and match the opaque
request tokens to gateway/Core records. Determine which intervals dominate before
changing connection limits or request scheduling. Native input delivery, actual
paint, and the function responsible for unmeasured React/JS work remain outside
this transport measurement.
