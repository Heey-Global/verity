# Selected-session diagnostic capture

Version 3 negotiates `remote-diagnostics-v3` explicitly. Versions 1 and 2 retain
their existing contracts; an unsupported selected capture fails without fallback.
The authenticated start request includes the admitted target session ID before
the App DATA socket starts. Exported evidence contains only its SHA-256 prefix
(16 lowercase hexadecimal characters). Core retains summaries for that session.

Preparation lasts at most 15 seconds. Uplink starts the requested active window
(1–30,000 milliseconds) only after both selected sockets are bound and the pair
is active. The App requests 30 seconds, probes the connection, then reads fresh
status before displaying Ready. The countdown describes the local
recorder. Uplink activation and probing precede Ready, so the remote window may
end sooner; Ready does not promise another 30 seconds. Missing bindings, pair replacement, capacity
termination or unavailable status cannot establish readiness. An existing
installation socket may have a late baseline; unrelated sessions consume no
selected recording budget. A reconnect ends the run instead of switching pairs.

The overall Uplink deadline is monotonic and at most 45 seconds. App status checks
are non-overlapping, run approximately once per second and abort after three
seconds. Losing reachability makes readiness unconfirmed while preserving local
evidence. Local collection never waits for remote Stop. The native recorder's
existing 120-second safety limit remains in effect if the UI is suspended.

## Sampling and coverage

The selected collector retains an aggregate baseline and one-second periodic
samples for each peer. The first periodic sample with buffered bytes or a pending
drain starts one 100-millisecond burst lasting one second for both peers. The
burst cannot retrigger or extend the deadline. Shorter pressure events between
samples can be missed; absence of a burst does not prove absence of pressure.

Binding records contain identity and time with a null snapshot. Periodic and
burst snapshots omit per-stream arrays. Each final snapshot retains at most eight
stream summaries and reports omitted detail through `truncatedStreams`. Binding
and final records have reserved capacity. The enforced worst-case allocation is
226,304 bytes and 86 records, within the unchanged 256-KiB and 2,000-record limits.
The Uplink maximum-counter fixture with 64 streams per peer completes 30 seconds
with a pressure burst, 84 records and a 145,346-byte full export, without dropped
records or diagnostic errors. Its finals retain eight streams and explicitly omit
56 each. These observed fixture sizes are not universal maxima.
Actual intervals, scheduling lag, dropped records, omitted bindings and terminal
reasons remain explicit. Resource limits can end a capture early; readiness is
not a guarantee of future coverage.

## Export validation

The strict v3 metadata includes selection, sampling policy, capture dates and
per-peer readiness. Live status refreshes readiness; terminal metadata freezes
with `ready: false`. Canonical hashing uses the complete metadata and ordered
records, with the same sorted-key JSON algorithm as v2. Pagination fields,
response fields and the hash itself are excluded. Core checks immutable page
metadata, contiguous records, the selected session and the final hash. The App
independently validates the schema, requested version and canonical hash.

UTC timestamps from different hosts do not establish ordering. Socket counters
and local send completion do not prove remote delivery or identify a Gateway
fault. Diagnosing the transport requires a separately collected device capture.
