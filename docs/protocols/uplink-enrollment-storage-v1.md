# Enrollment key storage and result recovery v1

Status: concrete proposal for joint review, not implemented or approved. Companion
to enrollment revision 5. Backup restore remains outside v1. Normal restart,
update or reconnect never deletes existing pairings.

## Existing facilities and limitations

`packages/store/src/crypto.ts` provides `createSealableSecretCipher`, AES-256-GCM
with random 12-byte IVs and a versioned `enc:v1:` envelope. It is a reusable
cryptographic primitive, not a ready recovery-record store. Its compatibility
paths accept plaintext, and `createPassthroughCipher` writes plaintext. Neither
behavior is allowed for enrollment results. The cipher has no record-bound AAD
or multi-key/key-ID envelope; those properties must not be claimed.

`packages/server/src/secret-lifecycle-routes.ts` initializes a password-derived
key and unlocks that cipher. Initialization currently consumes a bootstrap before
later credential issuance; it is not the proposed atomic enrollment transaction.
`apps/mobile/lib/authToken.ts` uses SecureStore with `AFTER_FIRST_UNLOCK`; that
existing setting does not establish the stricter new device-only key policy.

## Apple device storage proposal

Use a dedicated native enrollment module to generate Ed25519 signing material
and sign challenges without exposing the private key to JavaScript. Store private
key bytes as a Keychain item with proposed attributes
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and `kSecAttrSynchronizable = false`,
restricted to the app's own access group. Do not claim Secure Enclave backing for
Ed25519. Validate the native implementation on supported iOS/macOS targets before
freeze; official Apple documentation lookup was unavailable in this session.

An operation record binds server identity, invitation, operation ID, original
redemption, public-key fingerprint and private-key item reference. Protect the
invitation secret with the same device-only policy. Persist both before sending
commit; never regenerate a key silently for an existing operation. Interrupted
writes leave an incomplete local operation that cannot send commit until repaired.
Keep at most eight pending enrollment operations per app; reject capacity rather
than silently evicting a potentially committed operation. Exclude records from
app backup/export, logging, crash attachments and shared defaults.

Enrollment and recovery are foreground operations: locked-device/key-unavailable
errors wait for unlock and user retry. Do not fall back to weaker accessibility
or store keys in ordinary preferences. App reinstall is not a guaranteed erase
of Keychain state and is not automatically a fresh identity. An installation-local
marker may detect a changed app installation, but must not silently select an
old credential; explicit resume still requires the matching protected operation
and server proof. Missing key material cannot be replaced to recover an old result.

Keep the device signing key after successful enrollment as the device binding
key; remove only the invitation secret and pending recovery state after durable
credential/profile storage and acknowledged completion. Explicit removal of a
server profile may delete its local key without automatically claiming server-
side revocation succeeded. Scope this policy to the new enrollment path; migration
of existing credential storage is separate work, not implied by this proposal.

## Core recovery-record storage

Require an explicitly configured, unlocked `SealableSecretCipher` for commit or
result retrieval. Reject passthrough, plaintext and malformed envelopes even if
the generic cipher accepts them. Encrypt a structured result containing schema
version, server ID, installation binding, purpose, invitation/operation/receipt
IDs, device/public-key fingerprint, token ID, token and `recoveryUntil`. Compare
all these fields with the immutable authorized receipt after decryption. This
binds a valid ciphertext to its intended record and rejects ciphertext swapping;
a successful GCM authentication alone is insufficient. Never persist plaintext
result fields or export the master key for this feature.

Persist immutable authorization/consumption receipt, token verifier, encrypted
result and team commit outbox atomically. Encryption failure aborts the commit.
Do not claim database and filesystem operations form one transaction. Store only
opaque cipher output in the result column; place a checked schema version and
expiry alongside it for cleanup without decryption. Ordinary credentials and
consumption tombstones outlive deletion of the recovery copy.

Sealing blocks new result encryption and recovery reads with a retryable
`recovery_locked` error after appropriate authentication; it never consumes a
new invitation or deletes a receipt. The existing protected unlock procedure
must succeed before retry. No endpoint exposes master keys, and recovery itself
must not grant arbitrary secret-store unlock authority.

## First administrator and an uninitialized secret store

Avoid a circular dependency: initial-admin setup must initialize encryption
before committing a recoverable administrator result. Propose a separate
`POST /api/enrollment/v1/initialize` within the verified join-only TLS context.
It uses a fresh device-proof challenge with action `initialize` and the same
invitation secret checks; add that action to the reviewed transcript enum. Its
request contains the complete proof fields plus `masterPassword` (maximum 1024
UTF-8 bytes, no logging). The signature need not expose the password: pinned TLS
protects its transport; the handler may act only after proof validation.

Serialize this action with local initialization and initial-admin commit. Only a
valid unclaimed initial-admin invitation can create new key metadata and win the existing key-metadata
compare-and-set. Persist an initialization-owner binding to invitation, operation
and device key in that same database transaction, but do not consume the
invitation or issue a credential. Challenge consumption is atomic with it.
Limit password derivation with the existing throttle/concurrency guard.

If its response is lost or Core restarts sealed, the same proved operation may
retry initialization using a fresh challenge and the same password to unlock the
existing key; it cannot overwrite the salt/verifier. A different operation cannot
replace the winning initialization. Local setup winning the race prevents this
path from resetting its encryption. If the setup invitation expires before commit,
existing trusted installation recovery must issue a new authorized setup attempt;
never automatically clear key metadata. Password loss has no remote bypass.
The app does not persist this password as enrollment recovery material.

Once encryption is available, the ordinary signed `commit` performs the atomic
administrator claim and encrypted result write. This scoped initialization action
is proposed new work; do not simply expose `/secret/init` through the tunnel or
claim the existing handler already provides this device binding.

## Result lifetime, acknowledgement and key changes

Selected product policy: `recoveryUntil = committedAt + 86400000` milliseconds, a fixed maximum
24 hours with no sliding extension. Check expiry and current device/membership
revocation on every retrieval. Expired or revoked ciphertext is never served,
even if cleanup is delayed. Delete recovery ciphertext on acknowledgement,
revocation or expiry; run bounded cleanup at least once per minute. Database/WAL
physical erasure is not guaranteed by row deletion; backup restore is unsupported.

Propose `POST /api/enrollment/v1/ack` with exactly `operationId`, `receiptId`,
authenticated using the resulting device token over pinned TLS. Verify that token
belongs to that exact receipt/device, then delete the encrypted result atomically
and return 204. Duplicate acknowledgements for the same authorized receipt are
idempotent. An invitation secret or recovery ID alone cannot acknowledge. An app
sends ack only after credential/profile persistence and a successful authenticated
read using the saved credential; if ack is lost, retry using the saved token,
not the enrollment secret. Cleanup never revokes the working credential.

The current cipher has no multi-key rotation facility. For v1, changing the actual
encryption key is disallowed while unexpired recovery ciphertext remains unless
a separately reviewed atomic re-encryption process preserves it. Password changes
that preserve the actual key follow the existing supported key lifecycle; do not
assume all password changes do so. Key loss leaves recovery unavailable, not
plaintext or newly minted credentials. Ordinary restart uses the existing unlock
path; the recovery feature must not broaden `exportKeyMaterial` usage.

## Required evidence before approval

| ID | Case | Required observation |
| --- | --- | --- |
| ST01 | Lock device, restart app and reboot | Protected operation survives; signing waits for unlock; no silent key replacement |
| ST02 | Sync/export/backup and reinstall checks | No key migration or automatic adoption of a stale Keychain identity |
| ST03 | Passthrough cipher, sealed store or plaintext recovery row | No plaintext write/read; invitation unconsumed on failed commit |
| ST04 | Swap valid ciphertext between receipts | Binding mismatch rejects despite valid encryption tag |
| ST05 | Lost initialize response, restart, competing local setup | Same owner may unlock; no key replacement or duplicate administrator |
| ST06 | Commit then lose response | Same-device retrieval returns original token once authorized |
| ST07 | Early ack, wrong-device ack, duplicate valid ack | Wrong identity rejected; app orders persistence first; valid retries idempotent |
| ST08 | Expiry boundary, revocation and delayed cleanup | No result delivered at/after expiry or after revocation; working token unaffected by expiry |
| ST09 | Seal/unlock and actual key replacement attempt | No new key export path; pending results protected from unreadable rotation |

The maximum 24-hour retention is the selected product policy, not an open
duration choice. Native storage, initialization ownership and the key-change
restriction require joint approval; retention enforcement still needs tests. These are concrete proposals and test cases,
not executed evidence or permission to start runtime implementation.

## Integrated initialize schema

Enrollment revision 5 now owns the exact initialize request, response, errors and
fresh-challenge retry rules. The same proved initial-admin initialization owner
may unlock after interruption, including after commit only while its unrevoked
receipt is recoverable. It never reinitializes a claimed server. The app re-prompts
for the original master password and does not persist it. Team recovery cannot
use initialize; an authorized administrator must unlock Core separately.
Authenticated `recovery_locked` is reported only after proof and eligibility
checks. EN20–EN25 extend ST05; neither document claims those tests have run.
