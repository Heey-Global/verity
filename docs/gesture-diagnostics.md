# Overview gesture diagnostics

Settings → Diagnostics → Record overview gestures records how session rows in
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
2. Open Settings → Diagnostics and switch on Record overview gestures.
3. Swipe one session row in each project kind being compared, once to the left
   and once to the right.
4. Export the app update logs right away, then switch recording off.

The observer exists only while recording. Switching recording on or off
remounts the overview's session rows, and the observer adds a gesture
recognizer to each row. A fault that disappears while recording therefore
narrows the cause to row mounting or gesture arbitration, without telling the
two apart.
