# Core outgoing frame evidence

This preparation does not activate diagnostics or authorize a deployment, capture,
soak, or MSS change. Reuse the existing return-path collector and authenticated
installation consent; do not infer peer receipt from a local write callback.

`createRemoteConnectorPool` accepts an optional `returnPathSessionHash`: the first
16 lowercase hexadecimal characters of SHA-256 of the exact remote session ID.
Supply it explicitly through trusted pool configuration before reserving the
selected session. Other sessions produce no detailed return-path records. Omit
it to preserve existing installation-wide behavior. Empty, malformed, wildcard,
and first-session selectors are rejected. It does not grant consent or bypass
installation selection, absolute expiry, Stop, or recording-window guards.

Exact-session activation is supported through the authenticated V3 recording
endpoint and the opt-in admission hold described in
[selected-session recording](selected-session-recording.md). It binds a full
Uplink-issued session ID to the current Core reservation, then requires a validated
Uplink preparing ACK before App DATA. The static pool selector above remains a
compatibility option; it is not an activation procedure by itself.

Existing limits remain 128 detailed events, 64 stream summaries, bounded summary
output, and an absolute consent expiry within ten minutes. Overflow is explicit.
After event saturation, each tracked stream retains the first send and first
callback type, sequence when present, encoded/decoded byte counts, and callback
outcome. Types are allowlisted; unknown types are classified as `unknown`.
Session and stream identities are hashed. Payloads, tokens, tickets, arbitrary
error text, and URL/header fields are excluded.

`callbackMeaning=local_acceptance_not_peer_receipt` explicitly qualifies callback
success. It cannot establish TCP acknowledgement, proxy forwarding, Uplink
receipt, TLS progress, or client delivery. Existing generic transport counters
cannot retrospectively identify frame type or payload length.

The coordinated support-export schema projects the new first-frame type and
callback meaning as optional fields, preserving compatibility with older records.
The existing `onReturnPathSnapshot` -> recording manager `observe` -> export path
must be active for a later authorized capture. An empty/missing `remote.return_path`
section is a coverage gap, not proof that no frame was sent. Before activation,
verify exported Core records include these fields, explicit overflow, generation,
and session identity; do not substitute an aggregate transport-only projection.
