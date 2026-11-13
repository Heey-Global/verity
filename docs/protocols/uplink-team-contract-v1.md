# Uplink team contract v1 — reconciled decisions and status

**Status:** review contract, not frozen. No production route imports these
schemas, and team sharing stays disabled until Core and the hosted Uplink
service pass the same fixtures and the end-to-end join, turn and removal flow.

This document is the entry point for team sharing between a Verity installation
and Uplink. It records the decisions that resolve conflicts between the earlier
drafts and the current code. Where it disagrees with an earlier draft, this
document wins; the drafts keep their detail for everything not listed here:

- [Team-sharing protocol](uplink-team-sharing-v1.md): envelope, operations,
  redemption, removal, grants, lease states, errors.
- [Bootstrap interface](uplink-team-bootstrap-interface-v1.md): the app's
  admission request and the Core decision.
- [Grant signing profile](uplink-team-grant-signing-v1.md): JWS bytes and keys.
- [Enrollment](uplink-enrollment-v1.md), its
  [identity receipt](uplink-enrollment-identity-receipt-v1.md) and
  [storage](uplink-enrollment-storage-v1.md): device proof and recovery.
- [ADR 0023](../adr/0023-multi-user-projects-and-turn-identity.md): local users,
  project memberships and turn identity.

## Product scope

- A person is invited to **one project** with `read`, optionally `execute` and/or
  `manage`. Nothing else on the installation becomes visible: no other project,
  no instance-wide (shared) knowledge, no administration. The control-plane
  project cannot be shared.
- An installation has **no name**. People have a **display name**: the inviting
  user sets theirs once, the invited person enters theirs when accepting.
- Joining is **app-only**. The invitation link opens a static redirect page in a
  browser without the app; members have no browser access in v1.
- A person who already joined can be **added to further projects locally**,
  without a new invitation and without any Uplink message.
- Each person uses their own AI, GitHub, Google and secret connections.

## Decisions

### D1 Negotiation

Two negotiation points exist on purpose, one per socket:

- The installation's control connection uses `hello.teamVersions: [1]` and
  `welcome.teamVersion: 1`, plus the `team-sharing` feature for new grants
  (team-sharing §Compatibility).
- The app's admission socket uses capabilities, like Remote Control:
  `team-bootstrap-v1` for a join and `remote-control-v1` for a personal session.

Neither side sends `team.*` control messages without negotiated `teamVersion: 1`.
Core currently closes the control connection on an unknown frame type, so the
negotiation is what keeps older peers safe.

### D2 Strict messages

Every team message is a strict object: unknown fields are rejected. This
replaces the draft sentence that unknown optional fields are ignored. A new
field requires a new team version. Duplicate raw JSON keys and oversized frames
are rejected before parsing, as for Remote Control.

### D3 Time units

Control messages (`team.*` on the control connection) use integer epoch
**seconds**. Admission messages and the invitation envelope use epoch
**milliseconds**, like Remote Control. The schemas encode the unit per field.

### D4 Invitation identifier

`invitationId` is 32 random bytes in canonical base64url everywhere: control
messages, the join link, the bootstrap reservation and the enrollment proof.
Uplink assigns it in `team.invite.created`. Unauthenticated callers present it,
so no shorter or guessable form is accepted in any contract.

### D5 Invitation link

The link is `https://verity.build/join#<payload>`, where `<payload>` is canonical
unpadded base64url of the UTF-8 JSON envelope `invitationLink` (schema in
`scripts/team-control-contract`). It carries the same trust fields as the
enrollment envelope — `invitationId`, `secret`, `expiresAt`, `serverId`,
`identityKey`, `tlsPin`, `coreOrigin`, `uplinkOrigin`, `installationId`,
`installationHandle` — with `purpose: "team-member"`. For team members this
https form replaces `verity://enroll/v1#`, because only an https link on the
app's associated domain opens the app from a messenger or mail client.

- `team.invite.created` no longer returns `redeemUrl`. Core supplies every field
  it holds — `invitationId`, `secret`, `expiresAt`, `serverId`, `identityKey`,
  `uplinkOrigin`, `installationId`, `installationHandle` and `display` — to the
  inviter's own app over its authenticated connection. That app adds `tlsPin`
  and `coreOrigin` from the server profile it verified when it paired, and
  encodes the envelope. Core does not know its own pin (the installer hands it
  to the first device), and Uplink must never supply or alter it: the pin is
  what protects a joining device from Uplink itself. Uplink never sees the
  link, since the fragment never reaches a server.
- The full `tlsPin` is required. A short fingerprint shown in the UI is not a
  trust anchor.
- `serverId` must be recomputed from `identityKey`; a mismatch rejects the link.
- An optional `display` object carries `inviterName` and `projectName` so the
  redirect page can greet the person. These hints are untrusted: the app shows
  the inviter, project and permissions that Core returns after the pinned
  identity proof, never the hints.
- The fragment never reaches a server. The redirect page is static, loads no
  third-party script, sends no analytics, reads only `display`, and offers the
  store links and "open in app". This narrows, but does not remove, the
  enrollment draft's rule against web landing pages: the page never redeems,
  uploads or forwards the invitation.

### D6 Seats and `membershipRef`

`membershipRef` identifies a **person** (a local member user) per installation,
not a project membership. A seat is one person. Consequences:

- `team.join.commit` sends the person's `membershipRef` on their first join. A
  later project for the same person is a local membership only.
- `team.membership.remove` is sent when the person loses their last project or
  is deleted. Removing them from one of several projects is local only.
- The ten-member limit counts people.
- A removed person who is invited again gets a new `membershipRef`.

### D7 Join tunnel routing

The draft's version-2 connector preface and Core-UID socket are not
implemented. Instead, Core binds the purpose to the admission decision: a
tunnel accepted for a `team.join.pending` (capability `team-bootstrap-v1`) is
attached to a restricted listener that serves only the team-member enrollment
endpoint until enrollment completes. Ordinary project and administrator APIs
are unreachable on that tunnel. Personal Remote Control tunnels are unchanged.

### D8 Invitation list and cancellation

Core is the source of truth for invitations. Listing is local; there is no
Uplink list operation. Cancelling or expiring an invitation is local first and
then sent as `team.invite.cancel` through the outbox.

### D9 Display names

Core stores a display name per user. Uplink never receives display names,
email addresses or project names; the only path for names is the untrusted
`display` hint inside the link fragment.

### D10 Late admission decisions

A `session.accept` or `session.refuse` for an unknown, expired or foreign
session is ignored by Uplink. It must not close the control connection, because
Core can legitimately answer just after a deadline.

## Numbers

| Value | v1 rule |
| --- | --- |
| Invitation validity | default and maximum 7 days |
| Mutation retry window | 7 days from first attempt |
| Recovery window | 24 hours after the join commit |
| Revocation tombstones | kept permanently until late-message age bounds are fixed and tested |
| Member limit | 10 people per installation, enforced atomically at commit |
| Grant lifetime | 900 seconds, ±30 seconds clock tolerance |
| Admission decision | 15 seconds |
| Join ticket | earlier of 60 seconds after issue and 75 seconds after the request |
| Join tunnel | 5 minutes from attachment |
| Join gate revalidation | at least every 30 seconds |
| `team.error.retryAfterSeconds` | 1–3600, only when `retryable` |

## Implementation status (2026-11)

| Part | Core | Hosted Uplink service |
| --- | --- | --- |
| Local users, project memberships, read/execute/manage checks | Implemented (ADR 0023) | Not applicable |
| Display names on users | Missing | Not applicable |
| Personal Remote Control admission and opaque TLS tunnel | Implemented | Implemented; production enablement is a separate release step |
| Team control negotiation and `team.*` messages | Missing | Missing |
| Grant verification (JWS profile) | Verifier implemented, not wired; no generation floor | Signer missing |
| Join admission (`team.join.reserve` → `pending` → ticket) | Missing | Prototype only, not wired |
| Enrollment proof, recovery | Schemas and vectors only | Missing |
| Invitation, redemption, removal state and outbox | Missing | Prototype only, not wired |
| Preview feature rename `sharing` → `preview-sharing` | Pending | Pending |

## Corrections to earlier documents

- Personal Remote Control is implemented in Core: admission, tickets, the
  outbound connector and the app's pinned tunnel. Statements that it is missing
  in the channel protocol, the Remote Control draft, the team-sharing draft, the
  delivery plan, the T0 reconciliation and the TLS feasibility note are
  historical.
- The app reaches Core through pinned inner TLS over the tunnel plus its device
  token; the per-device end-to-end handshake described in the channel protocol
  is not what runs.
- `session.cancelled` in the bootstrap interface carries `code`, as its schema
  already requires.
- Bootstrap examples use 32-byte invitation ids (D4).

## Executable contract

| Bundle | Content |
| --- | --- |
| `scripts/team-control-contract/` | Control operations, events, `team.error`, negotiation fragments and the join-link envelope |
| `scripts/team-bootstrap-contract/` | Admission request, pending decision, tickets and errors |
| `scripts/team-grant-contract/` | Grant JWS verification vectors |
| `scripts/enrollment-proof/` | Device proof, recovery and initialization messages |

Each bundle checks its fixtures, its exported Draft-7 schemas and its named
semantic checks. The hosted service mirrors the exported schemas and fixtures
and pins their digest (`node scripts/team-control-contract/digest.ts`).

## Open before activation

- Production signing key bundle and `kid` for grants; persisted generation
  floor and trusted-time handling in Core.
- Fixed age bounds for late commits, recoveries and renewals, which then decide
  tombstone retention and any per-installation tombstone quota.
- Native key protection and physical-device evidence for the enrollment key.
- QR capacity of the join link on supported cameras.
- The hosted service implementing D1–D10 and passing the mirrored fixtures.
- An end-to-end run: invitation → join → personal connection → first turn →
  removal.
