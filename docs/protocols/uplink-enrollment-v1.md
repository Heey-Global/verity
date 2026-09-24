# Remote enrollment v1: invitation and recovery proposal

Status: revision 5 discussion draft accompanying Remote Control revision 4. Not approved,
implemented or frozen. Existing runtime remains unchanged.

## Evidence and trust material

`packages/server/src/device-pairing.ts` exports an Ed25519 SPKI identity key and
signs `verity.device-pairing.v1\0serverId\0challenge`. The app verifies this after
pinned TLS in `apps/mobile/lib/pairingSession.ts`. Its random persisted enrollment
ID is an idempotency identifier, not proof of a device private key.

`apps/mobile/native/CertificatePinDelegate.swift` pins SHA-256 of the 65-byte
uncompressed P-256 TLS public point, not certificate DER or the Ed25519 key.
It additionally verifies the logical HTTPS hostname and the delivered certificate
chain. Both the pin and existing fresh signed identity proof remain mandatory
before any enrollment secret is sent. Do not expose general device enrollment
as a team enrollment endpoint.

## Invitation envelope

Propose QR text `verity://enroll/v1#<payload>`, where payload is canonical unpadded
base64url of UTF-8 JSON, at most 4096 decoded bytes. Reject duplicate/unknown keys,
invalid UTF-8 and unsupported versions. Test actual QR capacity on supported
cameras before freeze. No secret in HTTP paths, query parameters, analytics or
web landing pages. The custom app-link handler needs platform validation; no
third-party shortener or fallback browser upload is allowed.

Exact fields:

| Field | Required representation |
| --- | --- |
| `version` | Integer 1 |
| `purpose` | `initial-admin` or `team-member` |
| `invitationId` | 32 random bytes, canonical base64url |
| `secret` | Independent 32 random bytes, canonical base64url |
| `expiresAt` | Positive safe integer Unix milliseconds |
| `serverId` | Existing identity-derived server ID |
| `identityKey` | Existing Ed25519 DER SPKI, base64url |
| `tlsPin` | Existing SHA-256 P-256 point pin representation |
| `coreOrigin` | Logical HTTPS origin, no credentials/path/query/fragment |
| `uplinkOrigin` | Configured HTTPS origin, same restrictions |
| `installationId` | Service UUID |
| `installationHandle` | Distinct service `welcome.handle` |

The installer terminal or authenticated inviter app supplies the trust anchor.
The relay cannot substitute it. Project, permissions and target identity remain
Core invitation state, never authority supplied by the app. Core verifies the
stored envelope binding and secret hash before consuming anything. Initial-admin
invitations expire after ten minutes; team expiry follows the separately approved
team policy. Store only a domain-separated hash of the secret at Core.

## Device proof proposal

Before contacting Core, persist the invitation and a random 32-byte `operationId`
in protected device-local storage. Generate and persist a per-enrollment Ed25519
key pair using a reviewed native cryptographic API. The private key must not sync
or enter shared backups. Hardware backing is not assumed. Native API availability
and key protection require review; this is new work, not current pairing behavior.
No new encryption layer is proposed: requests travel inside pinned TLS.

Propose inner `POST /api/enrollment/v1/challenge` with exactly `operationId`,
`invitationId`, `purpose`, `deviceKey`, `action` (`initialize`, `commit` or `recover`). Public
`deviceKey` uses canonical Ed25519 DER SPKI/base64url. Core returns `challengeId`,
`nonce`, `expiresAt`, `sessionId`, `redemptionId`, `recoveryReservationId`. Challenge ID and nonce are fresh
32-byte random base64url values; expiry is at most 60 seconds. Context comes from
the authenticated connector; initial-admin redemption ID is the empty string.
This request does not consume an invitation.

Propose `POST /api/enrollment/v1/complete` with exactly `challengeId`, `operationId`,
`invitationId`, `purpose`, `deviceKey`, `action`, `secret`, `signature`.
This endpoint accepts only `commit` or `recover`; `initialize` uses the route below.
The Ed25519 signature covers UTF-8 of the following ordered JSON array, serialized
without whitespace:

`["verity.remote-enrollment.v1", action, serverId, installationId, purpose, invitationId, operationId, deviceKey, sessionId, redemptionId, recoveryReservationId, challengeId, nonce, expiresAt]`

Restrict strings to their ASCII schemas and encode expiry as a decimal integer
without exponent notation. Require canonical public-key encoding and exactly
64 signature bytes. Core reconstructs this transcript from its stored challenge,
trusted context and bound key; never verify arbitrary caller-supplied bytes.
Validate the invitation secret independently with constant-time hash comparison.
This is a proposed protocol transcript requiring security review, not a reviewed
cryptographic construction ready to ship.

Consume challenges atomically with their action; session loss invalidates pending
challenges. Bound JSON requests to 16 KiB and pending challenges to four per
invitation and 64 per installation. Apply authentication throttles. Invalid,
expired or used proofs return generic `enrollment_rejected`; never log secrets.

## Atomic commit and lost response

In one Core transaction, consume the fresh challenge, recheck invitation expiry,
secret, purpose and device proof, serialize cancellation, consume the invitation,
and create the credential, operation/device binding and durable completion receipt.
Initial-admin commit also wins the same unclaimed-state transition as local setup.
Team commit rechecks inviter authority, grant and project rights, consumes the
redemption and writes the existing `team.join.commit` outbox entry atomically.

Return `operationId`, `receiptId`, `deviceId`, `tokenId`, `token`, `recoveryUntil`
inside TLS. The token is independently generated from 32 random bytes, base64url.
Store its normal authorization verifier and a separately encrypted recovery copy
of the exact result. Use an existing reviewed credential-encryption facility;
identifying that facility and its key lifecycle is a freeze prerequisite, not
permission to invent a cipher. No receipt or credential is delivered to Uplink.
The app durably saves credential and verified profile before clearing pending state.

The selected product policy is a maximum 24-hour recovery window after commit. A fresh tunnel and fresh `recover`
challenge require the same persisted device key, operation, purpose and invitation
secret. Core matches the committed receipt and returns the identical credential
only if it remains authorized. Recovery never creates a second membership, seat
or token. Invitation expiry denies new commits but does not deny recovery of an
already committed result within the window. Cancellation before commit wins;
revocation after commit prevents recovery. An authenticated acknowledgement may
delete the encrypted result early; consumed-invitation/operation tombstones remain.
Expired recovery or lost private key requires existing administrator or trusted
installation recovery, never automatic re-pairing or reopening initial setup.
Set `recoveryUntil = committedAt + 86400000` milliseconds without sliding
extension. Delete the encrypted result earlier on authenticated acknowledgement
or revocation. This policy does not expire the enrolled device credential and
does not constitute joint contract freeze or implementation approval.

Team recovery uses the separate reservation and trusted context below. It never
rebinds the committed redemption. Outbox acknowledgement loss continues retrying
the original `team.join.commit` identity.

Restart may discard pending challenges but must preserve committed receipts and
consumption state. Enrollment recovery retrieves a committed result after a lost
response; it never restores an old database. Backup restore and full-host rollback
are unsupported in v1. This scope decision defers a restore/anti-rollback design,
not the requirement to preserve consumed invitations and revocations in normal
operation. No automatic pairing deletion, blanket credential reset or destructive
restore workflow is introduced. Restart, update, reconnect and Uplink upgrade are
not restore triggers. V1 makes no safety or detection guarantee for an externally
restored old database; supporting that later requires a separate reviewed design.

## Joint acceptance scenarios

| ID | Stimulus | Required result |
| --- | --- | --- |
| EN01 | Wrong pin, hostname, chain or signed server identity | Fail before sending secrets |
| EN02 | Duplicate field, invalid encoding, oversize QR or unknown purpose | Reject |
| EN03 | Valid invitation, wrong device signature | No consumption or credential |
| EN04 | Replay proof with changed action/session/purpose/key | Reject reconstructed transcript |
| EN05 | Local and remote initial-admin commits race | Exactly one winner |
| EN06 | Commit response lost; fresh same-device recovery | Same receipt/token, one membership/seat |
| EN07 | Different key reuses operation after commit | No credential disclosure |
| EN08 | Invitation expires after commit, within recovery window | Commit denied; authorized recovery allowed |
| EN09 | Cancellation before commit or revocation before recovery | No authorization resurrection |
| EN10 | Restart with current durable database | Committed result remains recoverable; consumption and revocation survive; no pairing reset |
| EN11 | Lost key or expired recovery result | No automatic re-pair or initial-admin reset |
| EN12 | Team commit acknowledgement lost | Original outbox retried; no duplicate seat |

Review the encoding, device-key profile, transcript, enforcement of the selected retention, encryption
facility and team recovery admission jointly. Backup restore is outside v1. Only after schema
approval generate cross-language known-answer/negative fixtures and pin their
digest alongside reviewed Core/Uplink revisions. These scenarios are not executed
fixture evidence. Runtime implementation remains on hold.

## Trusted enrollment context: proposed remote-profile extension

For enrollment only, extend app `connect` with `enrollmentPurpose`:
`initial-admin` or `team-member`. Core treats it solely as a routing request.
Uplink copies it into `session.request`; only Core's authenticated acceptance
selects an enrollment handler. Initial-admin admission may reach only challenge,
commit and same-device recovery operations, never ordinary administrator APIs.
An already claimed installation rejects initial-admin commit, but may accept
bounded recovery against an existing, unrevoked receipt within its recovery
window. No new administrator can be created through that exception.

Extend the protected local connector preface as version 2 with exactly:
`version`, `sessionId`, `installationId`, `purpose`, `redemptionId`,
`recoveryReservationId`. `purpose` has the two values above; IDs follow the remote
ID schema except that inapplicable IDs are empty strings. Initial-admin uses two
empty IDs. Team commit uses its reserved redemption and an empty recovery ID;
team recovery uses the original committed redemption plus a new recovery ID.
Version 1 remains the revision-4 team-only proposal; no version inference or
fallback is allowed. Both drafts must be frozen with this explicit extension.

Use the revision-4 dedicated Core UID, OS peer check, 0700 directory, 0600 socket,
length prefix and 4096-byte bound. Core stores its accepted `session.request`
context before sending acceptance, keyed by current authenticated control binding,
session and installation. The handler matches the entire preface against that
record and claims it once before acknowledging and accepting TLS bytes. This
also works for initial-admin sessions without a pending team record. Team paths
add their reservation checks. Application HTTP fields cannot supply or override
this context. Socket loss invalidates all challenges issued on that context.

The signed transcript includes `recoveryReservationId` immediately after
`redemptionId`. It is empty except for team recovery. This revises the proposed
transcript before its first freeze; no old/new transcript guessing is permitted.
The challenge response includes this additional field. Core reconstructs session,
installation, purpose and both reservation IDs from the claimed context. A request
arriving on another session must obtain and sign a fresh challenge even if every
other field is unchanged.

## Separate post-commit recovery reservation

The app persists its original team `redemptionId` before attempting commit, along
with its operation/key. Recovery must not require a `receiptId` that may have been
lost with the completion response. On a separate admission WSS socket, propose:

```json
{"type":"team.recovery.reserve","requestId":"request_example","installationHandle":"handle_example","redemptionId":"original_redemption","operationId":"original_operation","capabilities":["remote-control-v1"]}
```

Exact fields are shown; no invitation secret, device key, signature or bearer is
sent to Uplink. The reservation is routing authority only. Apply ordinary remote
admission limits and generic public refusals. Uplink resolves the installation,
checks current transport/team eligibility and a live control binding, generates a
32-random-byte base64url `recoveryReservationId`, and sends on that control socket:

```json
{"type":"team.recovery.request","requestId":"request_example","recoveryReservationId":"new_recovery_id","installationId":"installation_uuid","redemptionId":"original_redemption","operationId":"original_operation","expiresAt":1800000060000}
```

Core locates the committed receipt by original redemption/operation and checks
installation binding, purpose, unexpired result retention, available encrypted
result, current membership/device/grant status and cancellation state. This is
only provisional routing approval: same-device proof is still required inside
TLS. Core sends exactly `type`, `recoveryReservationId`, `expiresAt` in
`team.recovery.accept`, or `type`, `recoveryReservationId`, `code: unavailable`
in `team.recovery.refuse`. The accepted expiry may shorten, never extend, Uplink's
proposed expiry and must not exceed `recoveryUntil`. Uplink waits at most 15 seconds
for the authenticated answer. Public responses expose no receipt or member status.

After acceptance Uplink persists a separate `reserved` recovery record with the
installation, original redemption/operation, control admission identity, expiry
and owning admission socket. Expiry is at most 60 seconds after the original
reserve request, not acceptance. Return exactly `type: team.recovery.ready`,
`requestId`, `recoveryReservationId`, `expiresAt` to that socket. Do not depend on
whether the original commit outbox has reached Uplink: only authenticated Core
can attest its local receipt. Uplink stores no credential or recovery result.

On that same socket allow exactly one subsequent ordinary `connect` extended with
`enrollmentPurpose: team-member` and `recoveryReservationId`; omit the normal
`redemptionId` field. Uplink derives the original redemption from its record and
atomically changes `reserved -> bound(sessionId)`. Reject mixed normal/recovery
fields, another socket, replay, stale control identity or expiry. This explicitly
extends the ordinary one-request/socket rule only for the reserve-then-connect
sequence. `session.request` includes the immutable purpose, original redemption,
operation and recovery ID; Core rechecks it against its accepted recovery record.
Tickets bind the recovery record and cannot be used for ordinary enrollment.
Activation and both ticket expiries must not exceed reservation expiry.

Reserve requests count toward the existing pending-session budget from arrival;
transition to connect must not allocate a second uncounted reservation. Allow
at most one live recovery reservation per installation/redemption/operation tuple;
concurrent requests receive a generic refusal. A stolen ID on another socket
cannot bind it, and possession of all routing IDs still cannot pass Core's fresh
same-device proof. Never put recovery IDs in public logs.

Core matches version-2 connector context to the old receipt, then verifies fresh
`recover` proof bound to the new session and recovery ID. Return the existing
credential result, not a new membership or seat. Mark the recovery reservation
terminal after retrieval or any transport failure. A lost result requires another
fresh reservation and proof; it does not consume the original receipt again.

Socket loss, reservation expiry, control replacement, transport revocation or Core
receipt/device/membership cancellation terminates the reservation and both data
legs. Core may send `team.recovery.cancel` with exactly `recoveryReservationId` on
its authenticated control socket; Uplink fences it before acknowledging normal
cleanup. Core still rechecks authority at result retrieval if that cancellation
message is delayed. Restart invalidates all pending recovery records/challenges;
committed receipts remain recoverable through fresh admission. Persist terminal
reservation state until expiry plus five minutes for replay prevention. Original
team commit outbox identity and consumption tombstones remain unchanged.

## Additional review vectors

| ID | Stimulus | Required result |
| --- | --- | --- |
| EN13 | Substitute session or installation after initial-admin challenge | Reject proof/context; no administrator claim |
| EN14 | App header or wrong-UID connector asserts initial-admin context | Reject before accepting enrollment authority |
| EN15 | Stolen recovery ID used from another admission socket | No reservation binding or credential |
| EN16 | Valid recovery transport, different private key | No result disclosure or second seat |
| EN17 | Concurrent recovery requests and duplicated connect | At most one live reservation and one session binding |
| EN18 | Core receipt committed, Uplink commit acknowledgement absent | Authenticated Core may approve transport; original outbox identity preserved |
| EN19 | Restart or cancellation between reserve, attach and retrieval | Old context fenced; fresh proof required; revoked result never returned |

These extensions resolve routing/context ambiguity as proposals, not approvals.
Uplink must review the reserve-then-connect exception, bounded state accounting,
Core-attested receipt eligibility and lifetime before joint freeze. Key storage,
The 24-hour maximum is selected; the encrypted-result facility remains subject
to review and evidence. Backup restore is
explicitly outside v1; it is not an enrollment-recovery prerequisite.

## Storage and initialization companion

The [key storage and recovery proposal](uplink-enrollment-storage-v1.md) identifies
the existing Core cipher, strict recovery wrapper, Apple device-only key profile,
24-hour result lifecycle and acknowledgement schema. The scoped `initialize` action is integrated below into the proposed challenge
and action schemas. All three actions require jointly reviewed fixtures before
freeze; this is not a claim of runtime support.

## Initialize: exact action and interruption behavior

The challenge action enum is exactly `initialize | commit | recover`. Use the
same transcript with its literal action; a commit/recover signature cannot
initialize or unlock. For `initialize`, require initial-admin purpose and empty
redemption/recovery reservation IDs. Team enrollment never accepts this action.

`POST /api/enrollment/v1/initialize` has exactly `challengeId`, `operationId`,
`invitationId`, `purpose`, `deviceKey`, `action: initialize`, `secret`, `signature`,
`masterPassword`. Apply the existing 16 KiB body cap, a nonempty password of at
most 1024 UTF-8 bytes and existing master-password policy. Do not normalize,
truncate or log the password. It travels only through the verified pinned inner
TLS session and is not part of the signed public transcript or recovery storage.
Reject unknown fields and action/endpoint mismatch.

Before revealing initialization/lock state or deriving a password key, verify
trusted session context, fresh signature, invitation secret and initialization
ownership. For a new setup require a live unclaimed invitation. A resumed setup
requires the persisted matching invitation/operation/device initialization owner.
After commit, that same owner may unlock only while its matching initial-admin
receipt remains eligible for recovery and its device is unrevoked. This exception
uses the committed receipt's recovery deadline, not an expired invitation's
commit authority. It neither creates a new administrator nor resets key metadata.
An expired uncommitted invitation cannot use it.

Success is HTTP 200 with exactly
`{ "operationId": "original_operation", "state": "ready" }`. Return it only
when the existing key verifier matches the supplied password and the cipher is
unlocked for the same key/owner, or after the winning new initialization transaction
has committed and unlocked. A repeated request uses a fresh challenge, checks the
same persisted owner/verifier, and returns the same logical result without changing
salt, key, invitation consumption or credentials. Never return a device token here.

| HTTP | Exact body shape | Behavior |
| --- | --- | --- |
| 400 | `{ "error": "invalid_request" }` | Malformed schema, action or size; no state change |
| 401 | `{ "error": "enrollment_rejected" }` | Invalid proof/secret, ineligible owner, expired authority or competing local setup; no lock-state disclosure |
| 403 | `{ "error": "password_rejected" }` | Only after full owner authentication; supplied password fails existing verifier |
| 429 | `{ "error": "rate_limited", "retryAfterMs": 1000 }` | Actual retry delay is bounded 1000–60000 ms; derivation/admission throttles apply |
| 503 | `{ "error": "temporarily_unavailable" }` | No ready-state claim; reconnect and obtain a fresh challenge |

Every authenticated action attempt claims its challenge once before password
processing; a wrong password or transient failure needs a fresh challenge. New
key metadata and initialization owner commit atomically; interrupted derivation
or a failed transaction cannot replace another owner's key. A crash after metadata
commit but before unlock is recovered by matching-owner retry with the same
password. The existing bootstrap-consuming `/secret/init` cannot substitute for
this contract. A local setup winning serialization returns generic rejection to
the remote contender, never an opportunity to overwrite its key.

For commit/recover, emit HTTP 423 with exactly
`{ "error": "recovery_locked" }` only after validating fresh proof, secret,
context and current invitation/receipt/device authority using non-secret metadata
and stored verifiers. Unauthorized requests still get generic 401, regardless of
whether Core is sealed. The 423 attempt consumes the challenge but not the
invitation or receipt. Retry requires a fresh challenge after unlock. Encrypted
result binding checks still run after decryption; metadata checks alone never
release a credential.

On first setup, the app asks for a new master password with confirmation. It keeps
it only for the foreground request, never in the pending operation, Keychain,
logs or telemetry. On interruption, resume the persisted operation and key rather
than generating replacements. Prompt: “Enter the master password you chose for
this setup.” Re-enter it through a fresh signed initialize request. If the first
request never committed, the winning initialization may create the key; otherwise
only the existing verifier can authorize unlock. Wrong-password feedback appears
only after owner proof. Cancellation leaves pending state intact for later retry;
no automatic password reset or invitation replacement occurs.

After a sealed restart before commit, the matching initial-admin owner uses this
same flow. After a lost commit response, recovery first proves the original device;
if it receives authenticated `recovery_locked`, the eligible initial-admin owner
may use initialize solely to unlock, then fetch a fresh recovery challenge. A team
member is told an administrator must unlock Core through the existing authorized
procedure; the member is never asked for or given administrator unlock authority.
Ordinary paired administrator unlock remains separate. Lost-password support is
outside enrollment recovery and cannot bypass the existing key verifier.

## Initialize acceptance additions

| ID | Scenario | Required result |
| --- | --- | --- |
| EN20 | Initialize commits but response is lost | Same owner/password and new challenge return ready without new key metadata |
| EN21 | Sealed restart before admin commit | Prompt for original password, same device proof, unlock then fresh commit proof |
| EN22 | Competing local setup wins or another key claims ownership | Generic rejection; no key replacement |
| EN23 | Wrong password, replayed challenge or action substitution | Password failure only after owner proof; replay/substitution rejected |
| EN24 | Unauthorized request against sealed versus unlocked Core | Same generic refusal; no recovery_locked oracle |
| EN25 | Lost commit response followed by sealed restart | Eligible original admin may unlock and recover; team member cannot initialize |

Add `initialize` known-answer and negative transcript fixtures alongside commit
and recover. EN20–EN25 expand ST05; these remain required, unexecuted evidence.
The 24-hour maximum is selected. Native platform verification and executed
retention/cleanup tests remain required before joint approval.
