# Enrollment schema and fixture review packet

Status: review candidate, not a frozen contract or production implementation.
Basis: Enrollment revision 5, Remote Control revision 6 and its Team companion.
This working revision incorporates the proposed [identity and receipt profile](../../docs/protocols/uplink-enrollment-identity-receipt-v1.md).
Uplink confirmed the ownership boundary and UUID/handle mapping, not a joint freeze.
The historical 196-fixture counter-review applies only to the PR #721 artifacts.
The current candidate contains 253 fixtures; its independent Uplink execution is pending.
The accepted 24-hour recovery policy is unchanged. The previous simulator
evidence remains separate from the tests introduced here.

## Artifacts and execution

- `schemas.ts`: strict test-only validators for Preface v2, challenge,
  complete, initialize, initialize success/errors, acknowledgement, locked error,
  the six team recovery messages and recovery connect. `coreIdentity` is a reusable
  trust-field component (`identityKey`, `serverId`, `tlsPin`), not a new endpoint
  message or a complete invitation decoder.
- `wire-schemas.json`: portable JSON Schema draft-07 definitions exported from
  those validators. Each entry is an independent schema.
- `wire-fixtures.json`: named positive and negative decoded-message fixtures;
  each carries its target schema and expected result.
- `action-vectors.json`: five fixed public Ed25519 vectors covering initial-admin
  initialize/commit/recover and team-member commit/recover. Each contains exact
  ordered fields, UTF-8 transcript hex and signature. No private key is included.
  The server identity is an illustrative placeholder, not a verified invitation.
- `schemas.test.ts`: executes the fixtures and vectors, rejects substitution
  of every signed field, checks permitted action/purpose coverage and detects
  schema-export drift.
- `raw-wire.ts` and `raw-wire.test.ts`: test-only byte decoding guards for
  duplicate JSON keys, malformed UTF-8, the framed version-2 preface, the
  16-KiB HTTP body limit and the 4096-byte decoded QR payload limit. They do
  not define a complete invitation schema or production route behavior.

From the repository root:

```sh
npm run enrollment:schemas
npx prettier --write scripts/enrollment-proof/wire-schemas.json
npx vitest run scripts/enrollment-proof
```

Native CI runs this entire directory before the existing Apple probes. The five
new signature vectors have been executed in Node only; the existing Swift probe
still uses its original vector. No new Swift or Uplink execution is claimed.

## Portable validation requirements

The JSON Schemas reject unknown keys and enforce required fields, action enums,
canonical base64url lengths/tail bits, Ed25519 SPKI prefix, integer timestamp
bounds and applicable Preface reservation combinations. Recovery connect must
omit the normal redemption field. Team callers cannot request initialize.

Consumers must additionally implement these checks from `accepts`:

- Password length is 1–1024 UTF-8 bytes, with no normalization or truncation.
  JSON Schema string length alone does not enforce the byte bound.
- Capability names are unique and include `remote-control-v1`.
- `coreIdentity.serverId` must equal the existing domain-separated, truncated
  SHA-256 derivation from its canonical `identityKey` string. JSON Schema only
  validates the two fields' shapes, not their relationship.

Receipts now require exactly 32 bytes of canonical base64url; recovery routing
handles require 16 bytes. Fixture handles have been updated from the earlier
32-byte placeholders to Uplink's issued profile. UUID spelling is preserved.
The original five signed action vectors remain byte-for-byte unchanged.

`coreIdentity.tlsPin` validates encoding only. It does not verify the hash target,
a peer certificate, its hostname or chain. Receipt shape tests likewise cannot
prove randomness, uniqueness, ownership or acknowledgement idempotency.

These checks are exercised by the same fixture set. Wire-shape acceptance alone
does not verify a signature, password policy or authenticated authority.
Synthetic fixture values are public test data, never real enrollment credentials.

## Evidence and remaining joint work

This packet covers the accepted extension's message shapes and transcript
bindings. It does not define the complete invitation decoder, ordinary admission
protocol or all response/storage schemas. Exact identity/pin representations and
receipt identifier profiles should be reconciled against their owning contracts
before expanding the packet. UUID syntax here does not prove service ownership,
and identifier length cannot prove random generation.

The first raw-byte tests now cover duplicate keys, malformed UTF-8 and the
preface, HTTP and QR byte limits. A portable raw-wire fixture corpus and actual
Core/Uplink decoder execution remain open; decoded JSON objects cannot preserve
that evidence. Request routing, initial-admin ownership, authorization,
same-socket reserve/connect, one-time claims, expiry comparisons, concurrency,
restart durability, outbox identity and revocation require executable stateful
Core/Uplink acceptance tests. In particular, a valid recovery expiry number does
not prove the 60-second reservation or fixed 24-hour result bounds. The existing
recovery model provides limited retention coverage, not production conformance.

Joint review must resolve these remaining profiles, have both implementations
consume the same fixtures, add raw-wire/stateful cases, then approve revisions
and fixture digests. No digest is pinned and no EN/ST scenario is declared fully
passed by these schema tests. Physical iPhone evidence remains outstanding.
Runtime code and production route wiring are unchanged.
