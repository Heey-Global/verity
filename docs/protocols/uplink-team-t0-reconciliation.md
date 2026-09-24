# Core response to the Uplink T0 handback

**Status:** Proposed; T0 is not frozen and T1 is not authorized by this review.

Inputs: Uplink handback at service base
`2a925eb47e73b2138d451ad954fca20f2fcf8d0e`, associated with private
[Uplink PR #26](https://github.com/Heey-Global/verity-uplink/pull/26), and the
[public protocol draft](uplink-team-sharing-v1.md). The shared handback was
available locally; Core could not fetch the private PR or the private ADR it
links. Service findings below are attributed to that handback, not independently
verified against private source. No runtime changes result from this response.

## Resolved documentation mismatches

- V01 now explicitly rejects retired `sharing` as preview authority. Only
  `preview-sharing` grants preview access, subject to its lease. No alias.
- The base channel feature example now uses `preview-sharing` and identifies
  the current runtime spelling as pending coordinated implementation.
- The delivery compatibility matrix is explicitly conditional on both sides
  having completed that pre-deployment rename.
- T5 includes missing Remote Control session admission, not merely validating
  existing tickets/streams. The handback reports that admission is absent in
  Uplink; the public transport document alone did not establish it existed.

## Actual Core pairing versus the proposal

| Area            | Core evidence                                                                                                                                | Implication                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Server identity | `packages/server/src/device-pairing.ts:70-78` requires Ed25519 and exports the identity key; lines 145–150 sign a domain-separated challenge | Existing server proof is reusable as a trust component, not a complete team bootstrap |
| Transport       | `apps/mobile/lib/pairingSession.ts:63-104` establishes pinned HTTPS then calls identity/enrollment APIs                                      | No application-layer end-to-end encrypted handshake is established by this code       |
| Client proof    | `apps/mobile/lib/pairingSession.ts:25-29` generates random challenge/enrollment identifiers                                                  | An enrollment ID is not proof of possession of a device private key                   |
| Enrollment      | `packages/server/src/pairing-routes.ts:79-111` exchanges invitation code/enrollment ID for a registered bearer                               | Do not route team joins to the existing general enrollment endpoint                   |
| Authority       | `packages/server/src/server.ts:4030-4037` accepts known bearer credentials at the existing global gate                                       | Local user binding and project-scoped authorization must exist before team admission  |

Pinned HTTPS protects the current direct app-to-Core connection. If an Uplink
bootstrap endpoint terminates HTTPS, forwarding those decrypted messages does
not preserve end-to-end confidentiality. Server signatures alone do not encrypt
invitation secrets or returned device credentials.

## Bootstrap decision required before contract freeze

Two viable approaches need joint selection and a transport feasibility review:

1. **Opaque TLS tunnel to Core.** Carry the app's TLS session through Uplink to
   Core without termination at the broker, preserving Core certificate pinning.
   Add scoped invitation transactions, explicit member identity/device binding
   and client key-possession proof. Prefer this if the mobile pinned transport
   and hosted relay can support it without weakening TLS verification. It
   reuses an established encryption protocol but requires tunnel/endpoint work;
   existing Uplink ticket primitives do not prove it is available.
2. **Application-layer end-to-end bootstrap.** Keep a broker-terminated HTTPS
   route but encrypt/authenticate the inner app-to-Core exchange using a
   reviewed standard construction and suitable library. Specify transcript,
   key confirmation, replay binding and secret recovery. This needs a new
   cryptographic protocol integration; do not describe it as reuse of current
   pairing or implement an ad hoc cipher exchange.

In both approaches, the invitation binds the intended Core identity and project,
permissions and redemption. Existing-account linking requires account proof,
not email equality. Returned credentials belong only to a local member and
must never unlock the administrator vault. The pending bootstrap channel cannot
call ordinary project APIs. Shared runtime credentials remain out of Uplink.

The requested [Core TLS feasibility review](uplink-team-tls-feasibility.md)
confirms the opaque-relay mechanism locally but identifies missing native mobile
integration. It does not yet select or validate a production transport.

## Signing and lifetime proposals still awaiting agreement

The service proposes Ed25519 with a configured verification-key set. Core's
existing Ed25519 instance identity does not make it the entitlement issuer:
service signing keys are separate. Prefer a standardized signed envelope with
fixed algorithm, explicit type/audience and trusted key ID, verified over its
specified bytes. Freeze a concrete profile and deterministic verification
vectors jointly; neither repository should independently invent serialization.
Key distribution/rotation, unknown-key handling, revocation floor persistence
and clock rollback remain required decisions.

The service proposes 15-minute signed team validity with no expiry grace. This
means direct member access ends at most 15 minutes after the most recent grant
if renewal becomes unavailable. It does not promise 15 minutes of availability
from the moment an outage begins. The existing hosted transport lease remains
separate. This availability/security tradeoff needs confirmation before being
made normative. Invite/reservation deadlines, renewal cadence, clock tolerance
and retry/tombstone retention are still unspecified; the 15-minute proposal
must not be silently reused for all of them.

## Return to Uplink and freeze checklist

- Acknowledge the V01/rename fixes and require them in both implementations.
- Select and validate the bootstrap transport with actual mobile/Core and
  Uplink capabilities; then specify endpoint, proof and encrypted framing.
- Agree signing profile and keys, time policy and all lifecycle/retention values.
- Convert all V01–V18 cases into one shared schema/fixture revision at T1.
- Commit and review the agreed public contract, then record that commit plus
  the matching private service ADR revision on both sides. No such contract
  commit exists yet; document checksums are not joint protocol approval.

No T1 implementation, deployment or team activation is implied by this record.
