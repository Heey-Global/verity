# Enrollment v1: identity and receipt profile

Status: proposed clarification of Enrollment revision 5 and Remote Control
revision 6. Existing identity encodings are derived from Core code; the receipt
profile is new proposed behavior. This document does not freeze the contract,
authorize production activation. The working schema/fixture candidate now
implements these shape constraints and the supplemental server-ID derivation
check; production behavior is unchanged.

## Identity ownership and exact bytes

All base64url below is RFC 4648 URL-safe encoding without padding. Decode,
check the exact byte length/structure, then re-encode and require equality.
Reject whitespace, alternate alphabets, padding and nonzero unused tail bits.
Do not normalize a value after it has been bound to an invitation or transcript.

| Field | Encoding and authority |
| --- | --- |
| `identityKey` | Core's Ed25519 public key: exactly 44 DER SPKI bytes, hex prefix `302a300506032b6570032100` followed by the 32-byte key; canonical base64url (59 characters). Never a TLS key. |
| `serverId` | `srv_` followed by canonical base64url of the first 16 bytes of SHA-256 over UTF-8 of `verity.device-pairing.v1.server-id`, one NUL byte, then the canonical `identityKey` string (26 characters total). Hash the encoded string, not raw DER. |
| `tlsPin` | Literal `sha256-` followed by canonical base64url of SHA-256 of the 65-byte uncompressed P-256 TLS public point `04 || X || Y` (50 characters total). Not a certificate hash, SPKI hash or Ed25519 hash. |
| `installationId` | Uplink's authenticated `welcome.installationId` UUID, distinct from Core's `serverId`. Preserve its issued spelling in stored bindings and transcripts; never case-fold signed data. Current fixture UUID validation accepts upper- and lowercase hex; syntax does not prove assignment or authority. |
| `installationHandle` | Uplink's separate `welcome.handle`, used for routing. The reviewed service generates 16 random bytes encoded as base64url. Do not derive it from the UUID or treat it as device authorization. |

The proposed invitation decoder must recompute `serverId` from `identityKey` and
reject disagreement before use. This is a new explicit validation requirement:
existing mobile pairing compares the advertised and expected server IDs and
verifies the signature, but does not independently recompute the derived ID.
Existing fixtures containing illustrative server IDs are transcript vectors,
not valid invitation examples; do not rewrite their signed bytes.

Core sources: `packages/server/src/device-pairing.ts` (`digest` and
`createDevicePairingManager`), `deploy/bin/verity-pairing-material`,
`apps/mobile/lib/pairingSession.ts`, `apps/mobile/lib/pinnedTransport.ts`, and
`apps/mobile/native/VerityPinnedTransport.swift`. Uplink ownership/handle evidence
is reported in the independent counter-review at Uplink commit
`6e6136802f04858414a0cfccd1e3349582b3b17e` (runtime base
`2a925eb47e73b2138d451ad954fca20f2fcf8d0e`).

## Trust checks before enrollment secrets

Use the trusted invitation's logical `coreOrigin` for inner TLS hostname and
origin checks, even when the underlying stream is relayed through Uplink.
The outer Uplink WSS origin is a separate trust boundary. A routing handle,
service UUID or admission ticket cannot replace the Core trust anchor.

The current Apple delegate first matches the leaf's P-256 point hash. It then
requires the delivered certificate chain to contain a separate anchor, uses the
last delivered certificate as a connection-local anchor, and evaluates the
chain with the expected logical SSL hostname. A pin match alone is insufficient;
missing chain, invalid chain, wrong hostname or wrong pin fails closed. See
`apps/mobile/native/CertificatePinDelegate.swift`. The invitation does not need
an additional certificate/CA field for this existing strategy: the server must
supply the required chain during TLS. This does not permit trusting arbitrary
chains before matching the invitation's leaf pin.

After TLS succeeds, require a fresh identity proof with the invitation's exact
Ed25519 key and server ID. The existing proof signs UTF-8 of
`verity.device-pairing.v1`, NUL, `serverId`, NUL, the fresh challenge string.
The fresh challenge is 32 random bytes in canonical base64url; the Ed25519
signature is 64 bytes in canonical base64url. Do not confuse this server proof
with the separate 14-field device enrollment action transcript. Send enrollment
secrets only after both checks succeed.

Neither an Uplink response nor a receipt authorizes changing a saved identity,
pin or logical origin. A mismatch requires trusted identity repair under the
existing policy, never automatic trust on first use. Key rotation and service
installation rebinding are separate lifecycle work; no new rotation protocol is
introduced here.

## Core completion receipt

Propose `receiptId` as an independently generated 32-byte cryptographic random
value, encoded as canonical base64url (43 characters), created by Core inside
the successful enrollment transaction. Enforce uniqueness in Core storage and
retry generation on collision before commit. It is an opaque lookup identifier,
not a bearer credential, signed grant, Uplink ticket or Expo push receipt.
Neither client nor Uplink chooses it. Do not derive it from an operation,
invitation, device key or token.

Persist one immutable receipt binding the Core identity, service installation,
purpose, invitation, operation, proved device key, resulting device/token IDs,
commit time and fixed recovery deadline. For team enrollment also bind the
original redemption and committed membership/project authority. Store encrypted
result material separately from the metadata required for authorization,
consumption and acknowledgement idempotency. Do not invent new `deviceId` or
`tokenId` encodings in this profile; they remain the Core credential store's
identifiers, not the new receipt namespace.

The enrollment transaction creates this receipt together with the existing
required invitation consumption, credential and team outbox effects. Retries
and recovery return the original receipt and result; they never allocate a new
receipt, credential, membership or outbox identity. Recovery locates the result
using the bound operation/key and authenticated context, without requiring a
`receiptId` that may have been lost with the response. Recheck current authority,
revocation and the fixed recovery deadline before returning ciphertext contents.

Acknowledgement sends `operationId` and `receiptId` over pinned TLS authenticated
by the resulting device token. Both IDs must select that token's exact committed
receipt; possessing either ID alone grants nothing. Atomically delete the
recoverable ciphertext, retain the authorized acknowledgement binding, and
return 204. Repeated valid acknowledgements remain idempotent after ciphertext
cleanup; they must not require decrypting an already deleted result. Revoked or
unrelated credentials cannot acknowledge. Neither acknowledgement nor expiry
revokes the enrolled credential. Uplink receives no receipt or credential.

## Compatibility and next review

The historical PR #721 Draft-07 `ack.receiptId` permits a generic 1–128-character
ID. The new working candidate narrows it to the 43-character receipt profile,
restricts recovery handles to the issued 16-byte profile, and adds a reusable
`coreIdentity` schema plus a supplemental server-ID derivation check. These are
test-only validators. The prior independent 196-fixture result does not cover
the new candidate. There is not yet a complete enrollment-success or invitation
schema; the trust-field component is not a complete decoder. Preserve the old
packet digests as historical review inputs. See the
[schema review packet](../../scripts/enrollment-proof/CONTRACT_FIXTURES.md).

Required follow-up evidence: canonical SPKI/server-ID derivation, key/ID mismatch,
wrong TLS hash target, malformed/noncanonical pins, receipt length/tail bits,
wrong-operation/device acknowledgement, acknowledgement after ciphertext cleanup,
concurrent commit/recovery uniqueness and the lost-response path without receipt
ID. Include native chain/hostname and physical-device evidence separately.

Uplink confirmed the UUID/handle binding, byte-preserving behavior and Core-only
receipt boundary in its shared `UPLINK_IDENTITY_RECEIPT_V1_REVIEW.md`. This
confirms the boundary, not execution of the new schemas or Core state behavior. No change to the existing five
signature vectors or 196 fixture expectations is proposed by the counter-review.
Freeze remains blocked on the remaining decoder, state/race and native evidence.
