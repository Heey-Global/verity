# Remote Control return-path diagnostics

Detailed return-path metadata is disabled by default. It supplements existing
transport counters without changing relay, TLS, admission, backpressure or
cancellation behavior. A successful Core WebSocket send callback establishes
local write acceptance, not Uplink receipt or Gateway forwarding.

## Core selection

Set both `VERITY_RETURN_PATH_INSTALLATION_ID` and
`VERITY_RETURN_PATH_EXPIRES_AT` (an absolute UTC timestamp). The expiry must be
within ten minutes of process initialization. An expired selection enables
nothing; a partial or invalid selection fails configuration validation.
The selected ID must match the authenticated Uplink installation descriptor.
The selector never changes the Uplink endpoint or installation and never grants
Remote Control permission. Restarting does not renew the absolute expiry.

Before activation, approve the selected installation, installed revisions,
expiry, collection scope and rollback. Clear both settings after the capture;
the automatic expiry stops detailed collection even when connections remain
open. Existing baseline diagnostics are unaffected.

## Metadata and limits

`remote.return_path` schema version 1 identifies a session, socket generation
and stream with SHA-256 fingerprints (first 16 hexadecimal characters).
Generation uses a fresh random identity for each connection. `eventOrder` and
monotonic `elapsedMs` establish order within one connection; wall clocks alone
cannot order events across hosts.

Core records emitted WebSocket-message counts, parsed-frame metadata, send
queue admission, send callbacks, fixed transport-error codes and close
observations. Parser observation does not establish stream acceptance.
Fields include allowlisted frame type, sequence, encoded byte length and
stream-data decoded byte length. No payload, ticket, token, header, URL,
arbitrary error message or raw identifier is copied into this event.
Unrecognized transport errors are reported as `unknown`.

Per connection, at most 64 stream fingerprints retain send totals and their
first send/callback metadata independently of the existing 16-entry trace.
The lifetime output budget reserves 128 of 256 records for summaries and 128
for detailed events. Summaries run every five seconds; detailed events appear
only once across successive summaries. `droppedEvents` and `droppedStreamObservations`
report omitted detail explicitly; the latter counts send/callback observations
without a retained stream slot, rather than distinct omitted stream IDs. Cumulative emitted-message counts and byte lengths, plus the latest allowlisted
transport error and close observation, survive detail saturation. Totals for retained streams keep updating
when the event budget is exhausted. Error, release and close paths export
available metadata, including late callbacks until consent expires; a final
summary has reserved capacity and is scheduled 100 ms before expiry, ending
detailed collection early. If event-loop delay passes the absolute deadline,
export is suppressed instead of extending consent. Summaries stop at release, and the
absolute expiry is checked during recording and export, independently of timer
delivery, and stops all detailed recording and export.

## Coordinated verification

The matching Uplink implementation must distinguish emitted WebSocket messages,
parser/tracker rejection, accepted stream data and app-facing writes. A raw
WebSocket-message count excludes bytes rejected below message emission and
cannot establish receipt of a particular missing frame. Uplink per-stream
accepted-ingress zero must not be described as zero raw network receipt.

Verify the installed revisions and metadata export before a separately approved
six-stream, 180-second app-tunnel soak. Preserve session records across every
event type until both DATA sockets close, with explicit pagination, rotation
and dropped-event limitations. Match fingerprints and sequence/byte metadata;
do not subtract unrelated counters across layers. If the evidence still cannot
distinguish Core-to-Gateway and Gateway-to-Uplink legs, record that boundary as
unknown instead of attributing the failure to the Gateway.

## Activation from a paired app

An administrator on a paired device can open Settings → Diagnostics → Connection
diagnosis. Start requires an agreed absolute UTC expiry within ten minutes of
Core's current clock. The app displays Core's UTC time through a suggested expiry;
use the same deadline when preparing the separate Uplink recording. Starting Core
alone does not activate Uplink or establish that a coordinated recording is ready.

The authenticated `GET`, `POST` and `DELETE /api/remote-control/diagnostics` routes
read, start and stop this temporary Core consent. POST accepts only `expiresAt`;
the installation is taken from the current authenticated Uplink descriptor.
Status includes a fingerprint, expiry, remaining duration, consent source and
number of connector generations assigned to the recording. Status or export
failure must not be interpreted as disabled recording.

Runtime consent is kept only in memory and is lost on Core restart. It ends on
explicit Stop, deadline, entitlement loss or installation change; a reconnect
cannot renew it. Monotonic time also bounds consent if the wall clock rolls back.
The existing startup selection remains supported and waits for its installation
to authenticate. Stop suppresses that selection for the current process; if the
startup settings remain configured and unexpired, a later process restart can
apply them again. Remove both startup settings to disable that source permanently.

Starting or stopping a runtime recording does not reconnect, close or reroute the
transport. Already existing connector generations join the capture; earlier
activity is not reconstructed. Repeated captures on one connector preserve its
lifetime stream and output limits. Stop flushes available metadata before ending
consent; a deadline never permits output after expiry. The app shows the most
recently confirmed status and permits a Stop request even when status reads fail.

For Uplink, use its separately reviewed activation and cleanup procedure. Its
startup configuration may require a deployment restart and interrupt active
connections. Verify both sides' actual metadata output for the selected session
before a coordinated test; after the run, Stop Core and remove Uplink's temporary
selection. Release installation, activation and the live test require separate
approval.
