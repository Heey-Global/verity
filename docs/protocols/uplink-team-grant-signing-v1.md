# Team grant signing profile v1 — joint review candidate

**Status:** Proposed. This profile completes the signed-grant part of the [team-sharing contract](uplink-team-sharing-v1.md). It does not enable team access in Core. Both implementations must accept the same vectors and production key bundle before activation.

## Wire format and signed bytes

`assertion` is a compact JWS with exactly three unpadded canonical base64url segments, `protected.payload.signature`, separated by ASCII dots. The signature input is the ASCII bytes of `protected + "." + payload`, exactly as received. There is no JSON reserialization or implicit canonicalization during verification. The signature is Ed25519 over that input; the signature segment decodes to exactly 64 bytes. Reject empty segments, padding, whitespace, noncanonical base64url, `b64:false`, detached payloads and any extra segment.

The protected header is a UTF-8 JSON object with exactly `alg: "EdDSA"`, `typ: "verity-team-grant+jws"` and `kid`. `kid` is an ASCII `[A-Za-z0-9_-]` string of 1–64 characters. No `jku`, `jwk`, `x5u`, `x5c`, `crit` or other header parameters are allowed. Reject duplicate keys in the raw header and payload before parsing into objects. The header never selects a remote key source or an algorithm: it only indexes an already trusted local verification-key set. A key is a 32-byte Ed25519 public value, distributed with a trusted Core release/configuration update, never learned from the assertion or unauthenticated control traffic. Core's instance identity key is not a grant verification key.

The payload is a UTF-8 JSON object with exactly these claims:

| Claim | Rule |
| --- | --- |
| `issuer` | Literal `verity-uplink`. |
| `audience` | Literal `verity-core-team`. |
| `installationId` | Exact service-assigned ID of the current authenticated installation, 1–128 ASCII `[A-Za-z0-9_-]` characters. |
| `teamVersion` | Integer `1`. |
| `grantId` | Opaque ASCII `[A-Za-z0-9_-]` string, 1–128 characters. |
| `generation` | Nonnegative safe integer. |
| `capabilities` | Exactly `["team-sharing"]` in v1. |
| `issuedAt`, `notBefore`, `expiresAt` | Integer Unix seconds. |

The issuer signs the literal JSON bytes it emits. A verifier rejects duplicate or unknown claims, malformed UTF-8, non-integer times, and a claim whose type differs from this table. Reordering JSON fields does not matter to claim validation because the signature covers the received bytes; neither side signs a parsed-and-reserialized object. `grantId` identifies one issuance and does not replace the durable generation/revocation floor.

## Time and durable authorization

The grant interval is at most 900 seconds: `issuedAt <= notBefore < expiresAt <= issuedAt + 900`. A verifier may tolerate up to 30 seconds of local clock error when checking `issuedAt` and `notBefore`; it never extends `expiresAt` by that tolerance. A grant is usable only when `now >= notBefore - 30`, `now >= issuedAt - 30` and `now < expiresAt`. Core persists the highest trusted wall-clock value observed with a grant. If the wall clock moves backwards beyond the 30-second tolerance, or trusted time cannot be established after a restart, cached grants do not authorize direct member access until fresh online validation establishes time again. An online refresh cannot revive an expired grant without a newly verified assertion.

The existing team contract's persisted generation and revocation floor rules apply after cryptographic and claim checks. A lower generation or revoked generation cannot be reactivated; an equal active generation may renew only with a consistent capability/installation binding and a later expiry. A replacement Uplink account, subscription key or installation identity invalidates all cached grants tied to the old binding. No offline grace period is added to `expiresAt`.

## Key distribution and rotation

The Core deployment contains an allowlist mapping `kid` to Ed25519 public keys for the selected Uplink service environment. The allowlist is installed through the same trusted Core release/configuration channel as other server trust settings, not fetched from a JWS header URL. An unknown `kid`, wrong key type or invalid signature fails closed. The issuer first makes a new public key available for Core deployment while continuing to sign with the old key; after deployed Core versions trust both, it may switch signing to the new `kid`. Keep the old public key until all grants signed by it have expired and a deployment/rollback window has passed. Removing a key makes any still-cached grant under it unusable. The private signing key never enters the Core repository, mobile app or Uplink control messages.

The production `kid` values and public keys are deployment inputs, not fixture keys. They must be pinned and checked in both implementation environments before team access is enabled. The fixture key below is public test material only and must never sign a production grant.

## Verification vectors

`assertion` fixtures in `scripts/team-grant-contract/` contain a deterministic test JWS, the test public key and negative cases for a changed signature, wrong audience, wrong installation and unknown key. The verifier must also test duplicate JSON keys, noncanonical base64url, expired/not-yet-valid grants, rollback, lower/revoked generation and equal-generation renewal. The fixtures establish exact signature bytes; they do not claim that the current Core control client verifies grants.
