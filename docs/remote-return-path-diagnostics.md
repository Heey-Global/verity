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
only once across successive summaries. `droppedEvents` and `droppedStreams`
report omitted detail explicitly. Totals for retained streams keep updating
when the event budget is exhausted. Error, release and close paths export
available metadata, including late callbacks until consent expires; the final
expiry summary has reserved capacity. Summaries stop at release, and the
absolute expiry stops all detailed recording.

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
