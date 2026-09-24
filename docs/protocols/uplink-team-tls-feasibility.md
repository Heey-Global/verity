# Team bootstrap: opaque TLS tunnel feasibility

**Status:** Core-side feasibility review; not a selected implementation or T0 freeze.

Related: [T0 reconciliation](uplink-team-t0-reconciliation.md) and
[team protocol](uplink-team-sharing-v1.md).

## Result

TLS through an opaque byte relay is feasible and preserves end-to-end transport
protection when the client validates the Core identity and hostname. Existing
mobile networking does not provide the required tunnel adapter. This is not a
configuration-only change. Service feasibility remains based on the Uplink
handback; private source and the actual hosted relay were unavailable here.

## Evidence from the current implementation

| Component             | Evidence                                                                                                         | Consequence                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile HTTP           | `apps/mobile/native/VerityPinnedTransport.swift:69-90` accepts a URL and uses URLSession                         | No custom byte-stream, proxy or separate dial-address injection                                                                           |
| Mobile WebSocket      | Same file, lines 193–205                                                                                         | Same tunnel integration gap for live sessions                                                                                             |
| Identity verification | `apps/mobile/native/CertificatePinDelegate.swift:119-147` verifies the pin and URL hostname                      | Replacing the Core URL with localhost or an Uplink host is not sufficient; do not disable hostname verification                           |
| Routing               | `apps/mobile/lib/client.ts:90-99`, `apps/mobile/lib/socket.ts:16-19`                                             | Existing Uplink path uses ordinary fetch/WebSocket rather than the direct pinned transport                                                |
| Profiles              | `apps/mobile/lib/serverProfile.ts:9-13`                                                                          | Logical Core identity must remain independent of temporary tunnel endpoints                                                               |
| Pairing               | `apps/mobile/lib/pairingSession.ts:68-86`                                                                        | Pinned TLS and the server identity challenge can be reused after transport integration; team scope/device proof still need implementation |
| Public tunnel codec   | `packages/preview-tunnel/src/framing.ts:305-309` accepts HTTP/WS stream-open channels; its tests reject `remote` | Existing public preview handling is not an opaque Remote Control TLS adapter                                                              |
| Hosted admission      | Uplink T0 handback reports missing connect/session-request/accept flow                                           | Tickets and streams alone are not an implemented end-to-end member transport                                                              |

## Local experiment performed

A temporary Node.js experiment created a TLS Core endpoint, an opaque TCP relay
and a TLS client. A temporary self-signed certificate for `core.test` was trusted
explicitly; normal hostname verification remained enabled and an additional
certificate fingerprint check was applied. No real account or credential was
used.

Observed results:

- The client received the expected response through the relay.
- A deliberately wrong pin was rejected.
- A deliberately wrong server hostname was rejected.
- The synthetic secret was absent from captured relay bytes in both directions.

This proves only the transport mechanism with Node's TLS stack. It does not
prove the iOS integration, production mobile pin implementation, WSS framing,
remote admission, backpressure, reconnection or hosted deployment. Captured-byte
inspection is a sanity check, not an independent cryptographic proof. The
experiment did not disable TLS validation. Temporary keys are not repository
artifacts and must not be reused.

## Integration paths requiring a spike

**Native tunnel/proxy integration:** preserve the logical Core hostname and pin
while routing transport through an opaque relay. This fits the desired outbound
Core connector but requires native mobile transport work. Do not assume
URLSession accepts a TLS-over-WebSocket byte stream: the present wrapper does
not expose one. A loopback forwarder must not change persisted Core identity,
token scoping or expected certificate hostname.

**Public opaque L4 endpoint:** the app connects to a routable endpoint whose TLS
session terminates at Core through its outbound connector. This can avoid a
custom app-layer cryptographic protocol, but Core's certificate must cover the
URL hostname, and Uplink needs routing/admission infrastructure. Invitation
identity and certificate lifecycle must agree. It must not become an unrestricted
public tunnel to the whole Core API or require inbound ports on the user's server.

These are candidates, not claims of tested platform support. Prefer testing
native integration against the actual iOS client first; if it cannot preserve
pinning and hostname validation reliably, compare L4 routing before selecting
additional application-layer cryptography. Any materially different architecture
needs an explicit joint decision before implementation.

## Next joint evidence needed before freezing bootstrap

Core should run the actual iOS pinned client through the candidate transport:
HTTPS pairing, WSS, uploads/downloads, wrong pin, wrong host, disconnect,
cancellation and enrollment retry. Existing hostname-negative smoke coverage is
in `scripts/ios-pinned-tls-smoke.sh:132-133`. A Node-only test is not a substitute.

Uplink should establish which opaque transport/admission path its deployment can
support, including per-reservation tickets, bounded buffers, backpressure,
timeouts and disconnect cleanup. It must not terminate inner Core TLS. Bootstrap
admission must remain restricted even if an attacker opens an authorized tunnel;
the Core endpoint still enforces invitation scope and cannot use existing
administrator-equivalent `/pair/enroll` unchanged.

Only after those checks should both sides specify exact routing, invitation
fingerprint/hostname, device proof and retry framing in the public contract.
Grant-signature format and entitlement durations are separate unresolved T0
choices; the transport experiment does not approve either.
