# Uplink team-sharing protocol — draft v1

**Status:** Proposed; no production support is claimed.

**Authority:** [Core ADR 0023](../adr/0023-multi-user-projects-and-turn-identity.md).
**Base transport:** [Uplink Channel Protocol](../UPLINK_CHANNEL_PROTOCOL.md).
**Delivery:** [Coordinated implementation plan](../uplink-team-sharing-delivery.md).

This document owns the public contract. Billing, subscription eligibility,
invitation storage and hosted relay implementation belong to the private Uplink
service. Both implementations must pin the same reviewed contract revision.
Names below are proposed wire names, not existing APIs.

## Existing baseline and compatibility

The current `packages/server/src/uplink-control-client.ts` speaks control
`protocolVersion: 1`, handles `welcome`/`renewed` leases and implements public
preview `share.create`/`share.remove`. Its `sharing` feature means public
preview sharing. It must not be interpreted as permission to invite team members.
The base protocol specifies Remote Control and its encrypted device handshake;
a specification alone is not evidence that all of that transport is implemented.

Team v1 is an opt-in extension on the authenticated control connection:

- `hello.teamVersions: [1]` advertises client support.
- `welcome.teamVersion: 1` selects support, independently of entitlement.
- `features` must explicitly include `team-sharing` to obtain a new team grant.
- Omission of `teamVersion` means unsupported, never an implicit v1.
- An unsupported version leaves existing preview and personal control flows
  unchanged; neither side sends `team.*` messages without negotiation.
- `preview-sharing`, `remote-control` and `team-sharing` are distinct permissions.
  Product plans may bundle them; clients must not infer one from another.

Unknown optional fields are ignored. Unknown message types cannot authorize
anything. Invalid required fields fail the request. A future incompatible team
contract negotiates a new team version; follow the base protocol's N/N−1
rollout rule. Do not change the base version merely to add optional handshake
fields. If implementation cannot preserve old behavior, revise this decision
and bump the base version before shipping.

### Proposed preview feature rename

Rename the preview feature directly from `sharing` to `preview-sharing`.
There are no running installations requiring the old feature name, so this
change needs no alias, dual emission or migration window. Coordinate the client
and service changes before release. This draft does not change runtime code.
The `share.create`, `share.remove` and related message names remain unchanged.

Updated clients recognize only `preview-sharing` for preview authorization.
The service emits it when preview access is granted and omits it otherwise.
`sharing` is no longer a recognized permission; neither it nor `team-sharing`
grants preview access. Preview authorization never grants team membership.
Renewal replaces the previous feature set, preserving existing revocation and
lease-expiry behavior. This pre-deployment rename does not require a protocol
version bump. Future deployed contract changes still follow the compatibility
rules above.

Extend V01 with feature sets `[]`, `["sharing"]`, `["preview-sharing"]` and
`["team-sharing"]`. Updated clients allow previews only for `preview-sharing`,
subject to the existing lease checks. Test renewal that removes it and verify
revocation. The service must not emit the retired `sharing` feature.

## Identity and trust

Use the service-assigned `installationId` from the base handshake; do not
introduce a competing instance identifier. Local references are always scoped:
`(installationId, projectId)` and `(installationId, userId)`. A user ID from one
installation is never an account on another installation.

The core authenticates the local inviter, checks project-management rights and
persists the intended role before asking Uplink to broker an invitation. Uplink
authenticates the installation and its service eligibility; it does not accept
an app-supplied inviter ID as proof. The control-plane project cannot be invited.

Joining proves possession of the invitation and a device key inside an encrypted
bootstrap exchange. The core establishes the local user/device identity; Uplink
does not become a global user directory or receive a private device token.
Emails and display names are metadata, not proof of account ownership. Adding a
device to an existing user requires authentication as that user; it cannot be
done by matching an invitation's email. Otherwise create a distinct local user.

Invitation bootstrap is an explicit extension to the base protocol's direct
first-run pairing assumption. The invitation link/QR must carry the intended
installation's public-key fingerprint, obtained from the authenticated inviter's
app, and an unguessable one-use bootstrap secret. The joining app pins that
fingerprint before sending secrets over the end-to-end channel. Uplink routes
the bootstrap but must never mint an administrator device credential.

Do not implement custom cryptography from this prose. Reuse the device-pairing
handshake after reviewing its suitability for scoped bootstrap. The exact key
encoding, proof transcript and secret delivery format are a release blocker for
contract freeze. This draft specifies the required bindings, not a finished
cryptographic handshake.

Core's [T0 reconciliation](uplink-team-t0-reconciliation.md) confirms that
current pairing uses pinned HTTPS and server identity signatures, not an
application-layer encrypted relay handshake or client private-key proof.
A broker-terminated HTTPS route cannot simply forward existing pairing safely.
The proposed enrollment path now uses pinned inner TLS over the Remote Control
tunnel, with the enrollment companion defining device proof and recovery. Joint
security approval and executable evidence remain required before freeze.

## Envelope and limits

Control messages are JSON objects within the existing 64 KiB client frame limit.
Request fields: `type`, `requestId` (UUID), and `teamVersion: 1`, plus the fields
listed below. Responses echo `requestId` and `teamVersion`. Events have an
`eventId` (UUID). IDs are opaque, bounded strings (1–128 characters); secret,
signature and URL fields require their own bounded schema at contract freeze.
Timestamps are integer UTC epoch seconds. Generations are nonnegative safe
integers. Malformed numbers, duplicate security-sensitive JSON keys and
oversized frames must be rejected before authorization.

A `requestId` correlates one attempt. Mutations also carry `operationId` (UUID),
which survives retries and reconnects. Idempotency is scoped to installation,
operation type and operation ID. Reusing it with a different payload returns
`idempotency_conflict`. A retry returns the same durable outcome; it cannot
create a second invitation or membership. Terminal tombstones must outlive
invitation validity and the agreed retry window; the exact retention interval
must be fixed before release.

## Control operations

| Request                  | Required payload                                                                                                             | Success response and payload                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `team.grant.get`         | None; instance comes from authenticated channel                                                                              | `team.grant`, `assertion`                                       |
| `team.invite.create`     | `operationId`, `localInviteId`, `projectId`, `permissions`, `expiresAt`, `bootstrapCommitment`, `installationKeyFingerprint` | `team.invite.created`, `invitationId`, `expiresAt`, `redeemUrl` |
| `team.invite.cancel`     | `operationId`, `invitationId`                                                                                                | `team.invite.cancelled`, `invitationId`, `alreadyCommitted`     |
| `team.join.commit`       | `operationId`, `invitationId`, `redemptionId`, `membershipRef`                                                               | `team.join.committed`, `redemptionId`                           |
| `team.membership.remove` | `operationId`, `membershipRef`, `reason`                                                                                     | `team.membership.removed`, `membershipRef`                      |
| `team.state.get`         | `knownGeneration`                                                                                                            | `team.state`, `generation`, `assertion` or `suspendedReason`    |

`permissions` is an explicit set of `read`, `execute`, `manage`; execute and
manage require read. No value represents instance administration. The core
stores the requested set and rejects a redemption with a different set.
`membershipRef` is an opaque receipt reference, not a personal account token.
The core creates a fresh, random one of at least 128 bits before
`team.join.commit` for every membership that joins through Uplink and never
reuses one after removal, so re-inviting a removed member is not blocked by its
tombstone; the owner and memberships created without Uplink have none.
`expiresAt` may be shortened by service policy; the returned deadline wins.
`redeemUrl` is restricted to the trusted Uplink HTTPS origin and contains no
provider credential. The bootstrap secret is not logged or sent over control;
only its commitment is registered. The final invitation link is assembled by
the trusted client using the reviewed bootstrap encoding.

Service events:

| Event                | Required payload                                                                 | Core action                                                             |
| -------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `team.join.pending`  | `requestId`, `sessionId`, `invitationId`, `redemptionId`, `projectId`, `permissions`, `bootstrapSessionId`, `decisionExpiresAt`, `capability` | Persist the bound pending context, recheck local invitation, then send `session.accept` or `session.refuse` |
| `team.grant.changed` | `generation`, `assertion`                                                        | Verify and persist; never broaden local membership                      |
| `team.grant.revoked` | `generation`, `reason`                                                           | Persist revocation floor and suspend team work before acknowledging     |

Reply `team.event.ack` with `eventId` only after the durable transition, except
that the bound `team.join.pending` admission uses durable `session.accept` as
specified by the [bootstrap interface](uplink-team-bootstrap-interface-v1.md).
Delivery is at least once; duplicate events have no extra effect. On reconnect fetch
`team.state` before enabling new team operations. A service rollback must not
reset the persisted revocation floor.

## Redemption and atomic membership

1. The app opens the invitation through Uplink's trusted bootstrap admission
   WSS. The [one-request bootstrap interface](uplink-team-bootstrap-interface-v1.md)
   atomically creates a short-lived redemption bound to one tunnel. This is a
   proposed new endpoint profile, not an existing public API.
2. Uplink emits `team.join.pending`. The core rechecks that the inviter remains
   authorized, the invitation is active and the project is shareable. A pending
   bootstrap channel is allowed to complete joining only; it cannot browse
   projects or execute turns.
3. The app and core establish the pinned encrypted channel. The core verifies
   the one-use bootstrap secret and device-key proof, then resolves a local
   identity as specified above. Uplink cannot substitute a different project,
   role, device or instance in this exchange.
4. In one local transaction the core consumes the invitation, stores membership
   and device binding, and writes a `team.join.commit` outbox item. A unique
   invitation/redemption constraint makes replay return the same receipt.
   Device credentials are delivered only inside the encrypted channel.
5. The outbox retries until Uplink acknowledges. A timeout after the local commit
   must not create another membership or consume a second seat. Recovery is
   keyed by the original redemption and proved device identity; a new claimant
   cannot retrieve an old claimant's credentials.
6. Cancellation, membership removal or loss of inviter authority racing with
   commit is serialized by the local transaction. Once cancelled, delayed
   success messages cannot reactivate it. Service acknowledgement does not
   override current local membership or entitlement state.

The service reservation persists sufficiently to reconcile a committed core
receipt after network loss. No distributed transaction is assumed. Core and
service must implement the same crash/retry vectors before enabling invitations.

## Membership removal

Removing a membership locally, directly or by deleting the user, takes effect in
the core immediately: it fences access and closes the member's connections
without waiting for Uplink. In the same local transaction the core writes outbox
items:

- one `team.invite.cancel` for every still-open invitation the removed member
  created, meaning no join for it is committed locally, whose
  `team.invite.create` was already sent. `team.invite.create` carries no inviter
  identity, so `membershipRef` cannot reach those invitations on the service
  side;
- one `team.membership.remove` for the membership whenever it has a
  `membershipRef`, including one whose `team.join.commit` is still pending.
  Deleting a user sends one per membership with a `membershipRef`.

An invitation whose `team.invite.create` was never attempted is dropped from the
outbox instead of cancelled; once transmission may have been attempted, the
create counts as sent. One that was sent but not yet acknowledged has no
`invitationId` yet; its cancel is queued behind the create and sent with the
`invitationId` from `team.invite.created`; the cancel's retry window starts when
`team.invite.created` is received. A non-retryable `team.invite.create`
rejection must leave no invitation or reservation on the service; the core then
drops the cancel. If that create is never acknowledged within the retry window,
the cancel cannot be sent; the invitation may stay reservable on the service
until its `expiresAt`, the core never commits a join for it, the invitee who
reserves it is told it is no longer available, and the admin sees it as
undelivered. A `team.invite.created` that still arrives later triggers the
cancel then, unless it arrives after `expiresAt`. The core drops every queued
cancel once its invitation is past `expiresAt`, since the invitation can no
longer be reserved. Cancelling covers invitations that are reserved but not
committed: the core never commits a join for them, and the service releases the
reservation. A membership the invitee already committed is its own membership
and is not affected by the inviter's removal. The removal and a local join
commit for one of the member's invitations are serialized on that invitation:
the join re-checks that the invitation is not cancelled, so a join commits
either before the removal selects the invitation or not at all.

`reason` is a closed enum with the single value `membership_removed`, sent for a
direct removal and for a user deletion alike, so the message carries no explicit
account deletion signal. Each membership's removal has its own independent
`operationId`; the removals of one deleted user can still be correlated in time,
but nothing else links them. Any other value is rejected with `invalid_request`;
new values need a new negotiated team version, so version skew cannot produce
one. The removal effect never depends on `reason`. The message carries only the
installation-scoped, opaque `membershipRef`; no email, display name, device key
or credential.

Outbox items keep their `operationId` across retries. Delivery is at least once
and the effect is idempotent. Once the core has recorded a removal it abandons
every queued or unacknowledged `team.join.commit`, recovery or renewal for that
membership and never sends or retries one again. The removal does not wait for
those abandoned items; after a removal the service rejects a `team.join.commit`
carrying that `membershipRef`, and a `team.recovery.reserve` whose
`redemptionId` the commit bound to it, with `revoked`, `retryable` false. A
commit rejected by a tombstone also blocks its `redemptionId`. When a commit or
recovery for a membership comes back `revoked`, the core fences that membership
locally as removed, for example after a restore from a backup taken before the
removal. Core refuses any forwarded `team.recovery.request` for a removed
membership itself. Renewal is per grant, not per membership, and never recreates
a removed membership.

If the member's own `team.join.commit` is abandoned this way, the core also
queues a `team.invite.cancel` for that invitation so the service releases its
reservation. `team.invite.cancel` for an invitation already committed on the
service returns `team.invite.cancelled` with `alreadyCommitted` true and changes
nothing; a cancel for an open, expired or already cancelled invitation returns
it with `alreadyCommitted` false, which is always present. An `invitationId` the
service does not know for the calling installation is rejected with
`invitation_unavailable`, `retryable` false, and the core shows that cancel as
undelivered like any non-retryable rejection. The service keeps expired,
cancelled and committed invitation records for at least `expiresAt` plus the
retry window, so a late cancel still finds them. For `alreadyCommitted` true
only: if the membership for that invitation is removed locally and the core
holds its `membershipRef`, the core sends `team.membership.remove` for it,
unless the removal path already queued it, and never queues a second automatic
removal; in every other case core and service disagree: the member stays fenced
in the core, and the core shows the invitation to the admin as inconsistent for
an admin action. `team.state.get` does not reconcile single invitations or
memberships; automatic reconciliation would need its own narrowly scoped
contract endpoint and is not part of v1.

The create and cancel of one invitation are sent in order. An item rejected with
`retryable` false, or still unacknowledged at the end of the agreed retry
window, stops retrying and is shown to the admin as undelivered; access in the
core is not affected. A `team.membership.remove` is exempt from the retry
window: it keeps retrying retryable errors until acknowledged and is shown to
the admin as pending after the window. A non-retryable error, such as
`invalid_request` or a permanent installation rejection, stops it and shows it
to the admin as failed. It is sent again only after the cause is fixed and an
authorized admin action triggers it, with the same installation, `membershipRef`
and removal intent under a new `operationId`. Until then the core alone keeps
the member out: it checks membership itself for direct and relayed access, so
nothing Uplink still renews or relays for that `membershipRef` admits them. The
service-side membership can therefore be active while a removal is pending or
failed, including when an earlier commit lands before the removal; the core
check is the only guard in that time, and the removal ends the service-side
membership when it lands.

Uplink records the removal, blocks the membership's join state and recovery
reservations, and writes its tombstone in one durable write before it
acknowledges; no later `team.join.commit`, recovery or renewal reactivates it.
It deletes personal metadata it no longer needs and keeps only a minimal
revocation tombstone, keyed by installation and `membershipRef`. The tombstone
is kept permanently. It may be given a finite retention only once T0 fixes, and
both sides test, an upper age bound for every late commit, recovery and renewal
message; the retention then covers the longest such bound plus the agreed retry
window, measured from the tombstone's durable write. The retry window and those
age bounds are fixed and tested together at T0. A `membershipRef` the service
has never seen or already removed is acknowledged as success and still leaves
the blocking tombstone for the calling installation, so the outbox does not keep
retrying and a later commit cannot activate it. Tombstones are never evicted
before their retention ends. The service never refuses a removal to save
tombstone storage; it may only defer removals per installation with
`temporarily_unavailable`, `retryable` true, so the core retries. A buggy or
compromised installation can therefore grow tombstones for never-seen refs; T0
decides whether a per-installation quota bounds them, and such a quota may only
defer with that same retryable error. The acknowledgement grants nothing and
never changes local core state.

## Signed team authorization

The service assertion covers: `issuer`, `audience: "verity-core-team"`,
`installationId`, `teamVersion: 1`, `grantId`, `generation`,
`capabilities: ["team-sharing"]`, `issuedAt`, `notBefore`, `expiresAt`.
The [grant signing profile](uplink-team-grant-signing-v1.md) proposes the exact
JWS bytes, Ed25519 key rules, lifetime and rotation with verification vectors.
Both sides must approve its production key bundle and vectors before activation;
never accept an algorithm or key URL merely because the assertion supplies it.

Validate signature, issuer, audience, instance, version, capability, time and
persisted generation before use. For equal generations only grants consistent
with the known state are accepted; a revoked generation cannot be reactivated.
A later grant must have a strictly newer generation to restore authorization.
Renewals may extend expiry at the same active generation; an older expiry never
replaces a newer one. Unknown signing keys fail closed.

`expiresAt` includes any service-approved offline allowance. The core invents
no additional grace period. Use bounded server time with rollback detection;
uncertain time after restart requires online validation. Exact clock tolerance
belongs in the frozen verification profile. Replacing the Uplink account/key or
installation identity invalidates cached grants from the previous binding.

## Lease, transport and access states

This extension deliberately separates team authorization from live transport.
The base control lease continues to govern previews and remote relay availability
unchanged. For negotiated team v1 only, a verified cached team assertion can
permit **direct** member access until its signed expiry despite control loss.
It cannot keep an unavailable relay alive. This is a scoped amendment to the
base document's blanket “all paid features” lease rule, not a change for old peers.

| Condition                               | New invitations           | Existing member direct access | Remote transport                          |
| --------------------------------------- | ------------------------- | ----------------------------- | ----------------------------------------- |
| Valid grant, live control               | Allowed with local rights | Allowed with local rights     | Requires separate transport authorization |
| Valid cached grant, control unavailable | Unavailable               | Allowed until signed expiry   | May be unavailable; no continuity promise |
| Expired or explicitly revoked           | Denied                    | Suspended                     | Team sessions closed/denied               |
| Unsupported extension                   | Unavailable               | Team feature unavailable      | Existing personal flows unchanged         |

A received base `revoke` or permanent credential rejection invalidates team
authority too; transport loss alone does not. Persist such invalidation so a
restart cannot reuse the old cached grant. Explicitly revoked generation floors
are durable. A disconnected core cannot learn revocation instantly; signed
expiry bounds that delay. Local membership removal is immediate locally and
never waits for Uplink. Renewal never recreates removed membership.

On suspension, fence queued/active team turns and credential grants, streams and
background work. Do not delete users, membership, history, files or knowledge.
Administrator personal access remains subject to ordinary local authentication
and vault rules. Already accepted upstream actions cannot be undone.

## Errors and privacy

All failed requests return `team.error` with `requestId`, `teamVersion`, `code`,
`retryable` and optional integer `retryAfterSeconds`. Codes:
`unsupported_version`, `not_entitled`, `authorization_expired`, `revoked`,
`forbidden`, `invitation_unavailable`, `idempotency_conflict`, `member_limit_reached`, `invalid_request`,
`temporarily_unavailable`, `internal`. Unknown codes grant nothing. The UI maps
codes to messages; service free text is not authority or executable instruction.
Retries use bounded backoff and the same operation ID for mutations.
`member_limit_reached` is retryable only while the original redemption receipt
is valid: the member stays pending and the same commit can succeed after a seat
is freed. After its age limit, `invitation_unavailable` is terminal even if a
seat later opens. Uplink enforces at most ten active memberships per installation
atomically at commit; reservations do not count as active memberships.
Unauthenticated callers cannot distinguish unknown, used and cancelled invites.

Never send provider tokens, Google grants, Doppler secrets, git signing keys,
project content or transcripts in these control messages. Bootstrap secrets,
device credentials, complete assertions and invitation URLs are omitted from
logs. Audit uses opaque IDs and outcomes. Resource access remains checked by
core even after successful transport admission.

## Shared conformance vectors

These IDs are the common test manifest for both repositories. Turn them into
versioned machine-readable fixtures and executable suites in delivery step T1;
the table itself is not a passing test suite.

| ID  | Input or fault                                                                                                  | Expected result                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V01 | No team negotiation; preview feature sets from rename clause                                                    | No team invitations; only `preview-sharing` authorizes previews                                                                                                                                                                                                                                                                                                                      |
| V02 | Valid assertion, member with read/execute                                                                       | Only authorized project accessible; turn uses member credentials                                                                                                                                                                                                                                                                                                                     |
| V03 | Signature altered, unknown key, wrong audience/instance                                                         | Reject; no grant installed                                                                                                                                                                                                                                                                                                                                                           |
| V04 | Expired/not-yet-valid assertion or uncertain clock                                                              | No authorization; request online validation as applicable                                                                                                                                                                                                                                                                                                                            |
| V05 | Grant at/below revoked generation after restart                                                                 | Remains suspended                                                                                                                                                                                                                                                                                                                                                                    |
| V06 | Disconnect with still-valid cached grant                                                                        | Direct access lasts only until signed expiry; no new invite                                                                                                                                                                                                                                                                                                                          |
| V07 | Reconnect after missed revocation                                                                               | Reconcile state before new team work                                                                                                                                                                                                                                                                                                                                                 |
| V08 | Same operation ID and payload twice                                                                             | Same durable result, no duplicate invitation/membership                                                                                                                                                                                                                                                                                                                              |
| V09 | Same operation ID, changed project or permissions                                                               | `idempotency_conflict`                                                                                                                                                                                                                                                                                                                                                               |
| V10 | Invitation consumed by another device                                                                           | Cannot retrieve credential or create membership                                                                                                                                                                                                                                                                                                                                      |
| V11 | Crash after local commit, before service acknowledgement                                                        | Outbox recovery confirms original membership once                                                                                                                                                                                                                                                                                                                                    |
| V12 | Cancel/removal races redemption; delayed success                                                                | No resurrection or privilege escalation                                                                                                                                                                                                                                                                                                                                              |
| V13 | Bootstrap fingerprint/proof/role substituted                                                                    | Reject before member credential issuance                                                                                                                                                                                                                                                                                                                                             |
| V14 | Entitlement renewed after local member removed                                                                  | Removed member stays denied                                                                                                                                                                                                                                                                                                                                                          |
| V15 | Three app profiles reuse a local project ID                                                                     | Tokens, notifications and requests remain instance-scoped                                                                                                                                                                                                                                                                                                                            |
| V16 | Member uses shared MCP service                                                                                  | Audit separates initiator and connection owner; no secrets logged                                                                                                                                                                                                                                                                                                                    |
| V17 | Base revoke or permanent key rejection then restart                                                             | Old cached team assertion remains unusable                                                                                                                                                                                                                                                                                                                                           |
| V18 | Read-only member connects through authorized relay                                                              | Cannot execute or access other projects                                                                                                                                                                                                                                                                                                                                              |
| V19 | Delayed `team.join.commit`, recovery or renewal after membership removal                                        | Commit and recovery reservation rejected with `revoked`, `retryable` false; renewal recreates nothing; membership stays removed on both sides                                                                                                                                                                                                                                        |
| V20 | Membership removed while Uplink is unreachable                                                                  | Access ends immediately; removal and the member's invite cancellations are delivered at least once after reconnect and take effect idempotently; a cancel still undelivered at the end of the retry window is shown to the admin as undelivered                                                                                                                                      |
| V21 | `team.membership.remove` with a `reason` other than `membership_removed`                                        | `invalid_request`; no state change                                                                                                                                                                                                                                                                                                                                                   |
| V22 | `team.membership.remove` for an unknown or already removed `membershipRef`                                      | Acknowledged as success; tombstone blocks any later commit                                                                                                                                                                                                                                                                                                                           |
| V23 | Membership removed while the member's `team.invite.create` is unsent, unacknowledged or rejected                | Unsent create dropped; sent create cancelled after `team.invite.created`; if the create is never acknowledged, the invitation may still be reserved but no join is committed and the invitee is told it is unavailable, also when the join races the removal; a non-retryable create rejection leaves nothing on the service; a late `team.invite.created` still triggers the cancel |
| V24 | `team.invite.cancel` races the invitee's reservation before commit                                              | Reservation released; core never commits the join                                                                                                                                                                                                                                                                                                                                    |
| V25 | Membership removed while its sent `team.join.commit` is unacknowledged                                          | Commit abandoned and its invitation cancelled; removal sent without waiting; a commit arriving after the removal is treated as removed, one arriving before it is ended by the removal; if the commit landed and only its ack was lost, the cancel is a no-op and the removal ends the membership                                                                                    |
| V26 | Inviter removed after the invitee's join is committed locally but before its `team.join.commit` is acknowledged | No cancel for that invitation; the invitee's membership stays active                                                                                                                                                                                                                                                                                                                 |
| V27 | Removed member invited again, also after the core is restored from backup                                       | Fresh `membershipRef`; the old tombstone does not block the new join; a restored pre-removal commit gets `revoked` and the core fences that membership again                                                                                                                                                                                                                         |
| V28 | `team.invite.cancel` for an invitation already committed on the service                                         | `team.invite.cancelled` with `alreadyCommitted` true; no service change; exactly one `team.membership.remove` for that `membershipRef` is queued if the membership is removed locally, otherwise the member stays fenced and the invitation is shown to the admin as inconsistent; an unknown or foreign `invitationId` gets `invitation_unavailable`                                |
| V29 | `team.membership.remove` rejected non-retryably, rate-limited, or pending past the retry window                 | Core still denies direct and relayed access; rate limit is retried; pending shown after the window; failed shown; re-sent only by an authorized admin action after the cause is fixed, same `membershipRef`, new `operationId`                                                                                                                                                       |
| V30 | User with several memberships deleted                                                                           | One `team.membership.remove` per membership with a `membershipRef`, each with `reason` `membership_removed` and its own `operationId`; no deletion signal                                                                                                                                                                                                                            |

For security guards, deliberately break the guarded verification and observe
failure. A simulator must consume these same vectors; it cannot define a second
protocol or provide a production entitlement bypass.

## Enrollment transport and post-commit recovery integration

This proposal incorporates Remote Control revision 6 and the revision-5
[enrollment companion](uplink-enrollment-v1.md), including its exact recovery
message schemas and version-2 local preface. The preface fields are `version: 2`,
`sessionId`, `installationId`, `purpose`, `redemptionId`, `recoveryReservationId`.
Team purpose is `team-member`; normal join uses an empty recovery ID, recovery
uses the original redemption plus its new one-use recovery reservation. Match the
entire tuple to Core's accepted control state through the protected Core-UID
socket. Adopt the revised signature transcript with it; no version guessing.

Keep the normal `team.join.pending` / local membership commit / `team.join.commit`
outbox sequence. For a lost post-commit result, use the distinct
`team.recovery.reserve -> team.recovery.ready -> connect` admission sequence.
Uplink forwards `team.recovery.request`; only authenticated Core returns
`team.recovery.accept` or `team.recovery.refuse` based on its receipt and current
rights. It may later send `team.recovery.cancel`. Core receipt eligibility does
not depend on whether the original commit outbox has reached Uplink.

The recovery record has its own ID, owning socket, stable control binding and
fresh session. Its absolute lifetime is 60 seconds, with a 15-second Core decision
bound; existing pending budgets apply from request arrival. Bind/consume once,
never reuse the committed redemption as a new join reservation. Core verifies
same-device proof inside TLS before returning the original credential result.
No second membership, seat or credential is minted; original commit outbox retries
retain their original redemption identity. Expiry, revocation, cancellation,
restart and replacement fence the new transport independently of the old receipt.

EN13–EN19 complement team V08–V13 for context substitution, stolen recovery IDs,
concurrent attempts and restart. This incorporates Uplink's accepted transport
state machine only. Native key protection, result encryption/retention,
and executable fixture evidence still block joint freeze. Backup restore is
unsupported in v1 per the enrollment companion; ordinary persisted revocation
floors remain required. No automatic destructive reset is introduced.

### Initialization authority boundary

The enrollment companion's initialize schema and retry/error behavior form part
of this contract's authority boundary. `initialize` is initial-admin-only and uses
the version-2 trusted initial-admin context; team join/recovery must reject that
purpose/action substitution even on an unclaimed Core. Master passwords never
appear in team reservation/control messages. A valid team recovery proof may
receive authenticated `recovery_locked`; an authorized administrator must unlock
Core separately. No team membership or reservation authorizes initialize.

EN20–EN25 supplement the existing EN13–EN19/V08–V13 context and recovery scenarios.
This synchronization does not pin schema revisions or authorize runtime work.
Native evidence and joint fixture approval remain outstanding.
