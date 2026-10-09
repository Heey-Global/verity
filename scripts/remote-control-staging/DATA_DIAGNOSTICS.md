# Bounded DATA disconnect capture

The mobile Connection diagnostics panel offers **Record connection test** and
**Copy connection recording**. Recording is opt-in for the current DATA socket
or, if none is live, the next attachment used by that test, including any automatic stall replacement. It never replaces a
live tunnel to obtain a recording. Ordinary tests and traffic do not enable it.
All generations in one test share the original 120-second deadline. After that deadline, recording and the network-path observer stop without stopping
the transport. A recorded socket cannot be rearmed after its window ends; use a
fresh attachment for a new recording. The native module keeps at most three
recorded socket generations in memory, including failed starts and stopped
tunnels. Restarting the app discards them. No upload happens automatically.

## Export schema

The clipboard export is a JSON array of at most three version-1 DATA snapshots.
Each snapshot includes:

- `generation`: a local UUID for this socket, **not** the Uplink connection ID.
- `sessionHash`: first 16 lowercase hexadecimal characters of SHA-256 over the
  exact unchanged UTF-8 session ID; omitted if attachment never supplied one.
- `clockOffsetKnown: false`: UTC is not sufficient to order events across hosts.
- `startedLate`, `delegateAvailable`, `expired`, `dropped`: explicit capture gaps.
- `captureLimitMs`: the recording time available to this generation, at most 120000 ms.
- `events`: at most 128 entries, preserving the beginning of the event sequence.

Each event contains `sequence`, UTC `utc`, monotonic local `elapsedMs`, and a
fixed `event` name. Optional fields are fixed cancellation/failure `cause`, an
allowlisted `errorDomain` and numeric `errorCode`, numeric `closeCode`, fixed
network `path` status, and `sentBytes` / `receivedBytes` / `deliveredBytes` counters.
Unknown error domains become `OtherErrorDomain`; descriptions and `userInfo`
never enter the recording. The JavaScript export validator rejects extra fields,
unknown enums, invalid ordering, and oversized output instead of silently
discarding records. No URLs, addresses, tickets, headers, content, or close
reason text are included.

`cancel_requested` is recorded under the tunnel stop lock before cleanup;
`socket_cancel` records the requested outgoing code before `socket.cancel`.
Attachment/read/ping errors are recorded before their resulting teardown.
`socket_close` and `task_completed` are passive URLSession delegate observations,
available only for a session owned by the production tunnel. An injected outer
session retains its original delegate and reports `delegateAvailable: false`.
`app_*` events describe JavaScript lifecycle notifications; `network_path` is an
NWPathMonitor observation, not proof of the path taken by a particular packet.
Counter events are cumulative tunnel payload counters, not raw WebSocket byte
counts or application acknowledgements.

## Historical baseline

The following is **reported k8s/Uplink evidence**, not independently reread raw
artifacts in the Core checkout:

| DATA session hash  | Core completed encoded frames/bytes | Uplink installation raw/dispatched | First observed Uplink APP close   |
| ------------------ | ----------------------------------- | ---------------------------------- | --------------------------------- |
| `6f98dae7bec40615` | 4 / 5480                            | 5 / 5552, including 72-byte attach | 2026-10-08 15:22:02.759 UTC, 1006 |
| `c1448f52fd7bef90` | 3 / 4851                            | 4 / 4923, including 72-byte attach | 2026-10-08 15:23:11.215 UTC, 1006 |

Both narrow log exports reportedly reached end-of-list without outer truncation;
rotation was unknown. The separate personal admission close at 15:23:08.286 UTC
is not the second DATA socket. Matching counters establish receipt at the
Uplink handler for the observed complete messages, not receipt on the phone.
Successful write callbacks and TCP ACKs are not phone or Core acknowledgements.
The live Cilium binary version remains unverified. The examined shared
GatewayClass logging path cannot isolate Uplink; no shared logging is enabled.

## Coordinated capture gate

1. Verify native compilation/simulator coverage and install the matching native
   app build; an OTA-only update cannot add these module methods. Confirm the
   safe export works without exposing unrestricted device logs.
2. Confirm Core `remote.transport` output and Uplink lifecycle/ingress/flow
   records are available, with a preserved same-process source order. Record
   actual installed builds and clock uncertainty, not just source versions.
3. Coordinate one capture of at most 120 seconds. Start Core/Uplink/cluster
   collection and confirm initial timestamped samples before requesting the
   phone action. Discover the current Uplink Pod and exact DATA session hash.
4. Use the installed k8s `diagnostic-bundle` for that Pod/hash/UTC window and
   retrieve its checkpointed artifact immediately with `bundle-read` if needed;
   verify SHA-256 and size. The peer reports a two-minute retrieval budget and
   one-hour artifact TTL. `tcp-sample` must overlap the live connection: current
   TCP samples cannot retrospectively describe a historical session.
5. Check section errors, limits, omitted sessions, fingerprints, PodUID, restarts,
   and log rotation. Collector `complete: false` must remain false. Preserve
   unavailable fields and failed stages; no claim of future export success
   follows from earlier historical captures.
6. Copy the mobile recording after the failure/stop, then join by exact session
   hash, party=app and overlapping lifecycle. Local generation IDs are not sent
   on the wire and cannot be equated to process-local Uplink UUIDs. Reject an
   ambiguous join when multiple APP attempts overlap.

## Interpretation and rollback

Local cancellation intent before a task error supports cancellation-first. An
error before local cleanup supports failure-first but does not locate a network
or Gateway fault. Missing cancellation proves nothing with late, overflowing,
expired or otherwise incomplete capture. Simultaneous UTC timestamps require
preserved same-process ordering; clocks on different hosts need measured bounds.

Uplink's peer is the immediate Gateway hop. Code 1006 indicates an incomplete
close handshake there, not proof that the phone cancelled. Its final close code
is received; `origin=broker` only marks local initiation, so sent and received
codes may differ. Encoded raw totals include attach/control messages and must
not be compared directly to payload flow bytes.

Disable recording with the native `disableDataDiagnostics` method, or let the
120-second limit expire; neither changes routing or closes the DATA socket.
Remove copied exports when the investigation is finished. Reverting the
diagnostics change is independent of transport routing. A dedicated diagnostic
Gateway/hostname, controller configuration or route switch requires a separate
concrete design and approval; this capture procedure does not authorize it.
