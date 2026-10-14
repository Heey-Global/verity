# Remote Control DATA contract

This contract applies only to `remote-control-v1`. The app, Core connector and
Uplink relay must enforce it together. Other Uplink channels have separate
contracts. Implementation and native integration results must identify both
repository revisions; component tests alone do not establish end-to-end support.

## Trust and readiness

The outer connection is WSS `/data` with normal server authentication. The app
authenticates the paired Core inside an opaque TLS byte stream and retains its
Core certificate pin. Core connects only to its administratively configured local
TLS listener. Stream metadata never selects another destination. Tickets appear
only in the first attachment message, never in URLs or diagnostic output.

Both authenticated parties must attach before Uplink activates the pair. Each
endpoint waits for its matching `attached` notification before sending stream
frames. Queuing both notifications is an ordering barrier, not a receipt from
either endpoint. Early stream frames are rejected, not buffered for later use.

## Frames and limits

Frames are complete UTF-8 JSON WebSocket text messages with exactly these fields:

| Type | Fields besides `type` |
| --- | --- |
| `attach` | `ticket` |
| `attached` | `sessionId`, `capability` equal to `remote-control-v1` |
| `stream.open` | `streamId`, `channel` equal to `remote`, `meta` equal to `{}` |
| `stream.data` | `streamId`, `seq`, `payload` |
| `stream.end` | `streamId` |
| `stream.reset` | `streamId`, `code` |

Only the app opens streams. IDs match `[A-Za-z0-9_-]{1,128}`. A pair has at most
eight live streams and 4096 distinct stream IDs over its lifetime. IDs cannot be
reopened after completion, reset or refused concurrency admission. A ninth live
open receives `concurrency_limit` only at the opening app, without terminating
sibling streams; Core receives neither that open nor its reset; exhausting
the lifetime ID budget ends the pair. Capacity is counted per logical stream,
not separately for its two directions.

Each direction starts its sequence at zero and increments once per data frame,
including an empty payload. Sequence values are nonnegative safe JSON integers
(at most 9007199254740991); Booleans, strings and fractional values are invalid.
Payloads use canonical padded Base64. Each decoded payload is at most 64 KiB;
each encoded JSON message is at most 96 KiB. Binary messages are invalid.

The reset codes are `protocol_error`, `concurrency_limit`, `upstream_error` and
`timeout`. Frames for an ID that was never opened are invalid. Structurally valid
late data/end/reset frames for a retired ID may be discarded to tolerate crossed
completion and reset; they must never reopen or deliver bytes. Validation still
applies to discarded frames. A repeated open is always invalid.

## Lifecycle and flow control

`stream.end` closes only the sender's byte direction, after its earlier bytes.
The opposite direction remains available. A stream completes after both
directions and queued local writes finish. Reset retires both directions of one
stream. Loss or cancellation of an outer attachment terminates the whole pair
and its streams. Reconnection requires new admission and a new tracker; there is
no automatic replay, resume or retransmission of application frames.

All queues are bounded. Core bounds each local write queue at 256 KiB and its
WebSocket send buffer at 1 MiB. App pending local writes are bounded at 256 KiB
per stream and 1 MiB per attachment. Local write stalls have 30-second deadlines.
Uplink pauses a source when its target exceeds 1 MiB, resumes below 512 KiB and
terminates sustained pressure after 30 seconds. These local budgets refer to
different buffers; they are not a negotiated credit window or receipt protocol.

App and Core originate hop-local pings every 15 seconds when no ping is pending;
a pending ping older than 45 seconds terminates the attachment at the next tick.
Uplink responds to pings. Pong receipt does not establish stream forwarding or
inner TLS progress. Native suspension can delay timer execution. The app also
has a ten-second first-response stall check that fires only if the entire
attachment received no additional payload during that stream's wait. Every app send is bounded
to 15 seconds; a send that misses that deadline ends the attachment so that
the app replaces it, since the heartbeat bypasses the send queue and
cannot notice a queue that has stopped draining.

Local send callbacks, socket counters, frame acceptance and endpoint receipt are
distinct observations. Tests assert exact bytes at their destination, not merely
successful send callbacks. Close code 1006 does not identify the initiating
application or the original failure. First local failure/cancellation ordering
must be retained separately from resulting cleanup failures.

## Verification

`remote-control-connector.test.ts` exercises the actual Core connector's limits,
sequences, half-close and new-connection behavior. `NativeProtocol.swift` calls
the actual app decoder with Foundation JSON values. The joint runner in
`scripts/remote-control-integration` uses the actual native tunnel, actual Core
connector and an externally checked-out Uplink admission/relay adapter.

The joint runner currently covers authenticated pairing, pinned inner HTTPS,
parallel exact-byte HTTP exchanges and idempotent native shutdown. HTTP request
completion is not evidence of a stream half-close. Fault injection and native
half-close coverage must be reported separately until actually executed. A
passing mock relay or Linux test does not substitute for macOS/iOS execution.
