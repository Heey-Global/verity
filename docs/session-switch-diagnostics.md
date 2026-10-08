# Session switch timing diagnostics

Settings → Diagnostics → Export app update logs includes `sessionSwitchTimings`.
The export identifies the running release, native build, stamped JavaScript commit,
OTA update ID and runtime/channel. Timings are held only in memory: export them
before restarting the app. No new diagnostic network requests are sent.

The buffer retains the last eight row gestures, at most 64 phases per gesture,
and collects for at most 30 seconds. Each switch has an opaque `switchId`, a wall
clock `at` for approximate correlation, and monotonic `elapsedMs` values. Session
IDs, titles, URLs, message text, credentials and response bodies are excluded.
Rapid switches supersede earlier gestures; late callbacks cannot add phases to
a replacement gesture, even when returning to the same session. Cancelled
touches are recorded. A touch without `js-press-handler` may be a scroll or long
press rather than a session selection. Keyboard/accessibility presses can begin
with `js-press-handler` and have no touch phase. Collection limits can truncate
long/repeated loads; absence of a phase alone does not prove a stage never ran.

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
message jumps and saved-anchor recovery can still load required pages before that
signal. Verify on a device by opening a long session at the newest edge: automatic
follow-up `events-request-start` should follow `flash-list-on-load`, and scrolling
backwards should continue loading history. Also verify a deep saved anchor and an
explicit message jump; those may legitimately request earlier pages.
