# Personal Remote Control RC-A staging candidate

This is a review artifact for an already paired personal device. It is not
imported by Core, the app or the hosted service. The proposed wire contract is
`docs/protocols/uplink-remote-control-v1.md` revision 7 candidate. Team joining, initial
administrator enrollment and upgrades are outside this fixture bundle.

`schemas.ts` is the source for the checked-in Draft-7 `wire-schemas.json`.
`wire-fixtures.json` covers valid and invalid message shapes. The negotiation
schema describes only the new `capabilities` and `channels` fragment of the
existing hello/welcome envelope; it is not a replacement base handshake schema.
`lifecycle-fixtures.json` covers admission, duplicate acceptance, the two-party
attachment barrier, cancellation, expiry and control replacement. These state
fixtures specify the intended result; the hosted implementation must prove it
against its real handlers and durable state.

Run from the repository root:

```sh
node scripts/remote-control-contract/export-schemas.ts
npx vitest run scripts/remote-control-contract/schemas.test.ts
node scripts/remote-control-contract/digest.ts
```

The portable schemas check structure. Consumers must additionally enforce the
named semantic checks in `accepts`: unique negotiation names, offered remote
capability, `retryAfterMs` only for `rate_limited`, canonical base64 and decoded
chunk size. A JSON parser must reject duplicate raw keys and enforce the 16 KiB
admission and 96 KiB remote-frame byte limits before parsing; parsed JSON schemas
cannot detect duplicate raw keys. Handle entropy, ticket ownership, time windows,
sequence state, queue budgets and TLS trust likewise need handler-level tests.

The staging ingress profile uses the socket peer IP only. Its conservative
remote-only ceilings are 32 active, 16 pending, 16 pre-request sockets and five
active per installation, subordinate to the existing shared limits. Rate limits
are 10/minute/handle and 30/minute/peer IP with at most 65536 limiter entries.
These values are candidate hard maxima for isolated staging, not measured
production capacity.

Before calling RC-A frozen, Core and Uplink must independently run the same
portable schemas and expected lifecycle fixtures in their contract harnesses,
mutate critical contract guards to see their tests fail, and pin the exact Core
commit, Uplink contract commit and SHA-256 of the same canonical fixture bundle
in their handbacks. A passing local fixture test alone is not that freeze.

RC-B/RC-C must then run these fixtures against real parsers, ticket and session
state, the attachment barrier and the native adapter. They must add the remaining
RC01–RC14 negative and transport cases, including renewal, replay, slow readers,
real TLS and hosted gateway behavior. Those runtime passes are separate from
the RC-A contract freeze.
