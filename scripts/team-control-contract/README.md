# Team control contract (team v1 review candidate)

Executable form of the Uplink team control extension: negotiation fragments,
the `team.*` control operations and events, `team.error`, and the decoded
`https://verity.build/join#` invitation envelope. The reconciled decisions are
in `docs/protocols/uplink-team-contract-v1.md`; the protocol detail is in
`docs/protocols/uplink-team-sharing-v1.md`. No production route imports these
schemas yet.

`schemas.ts` is the source for the checked-in Draft-7 `wire-schemas.json`.
`wire-fixtures.json` holds valid and invalid messages; every schema has at least
one of each. Consumers must also run the named `x-semanticChecks`:

- `retryAfterSecondsOnlyWhenRetryable` on `teamError`;
- `serverIdDerivedFromIdentityKey` on `invitationLink`: `srv_` followed by
  base64url of the first 16 bytes of SHA-256 over
  `verity.device-pairing.v1.server-id`, NUL, `identityKey`.

Parsers must reject duplicate raw JSON keys and oversized frames before parsing;
a parsed-object schema cannot detect either.

Run from the repository root:

```sh
node scripts/team-control-contract/export-schemas.ts
npx vitest run scripts/team-control-contract scripts/team-bootstrap-contract
node scripts/team-control-contract/digest.ts
```

The hosted service mirrors `wire-schemas.json` and `wire-fixtures.json` and pins
the digest printed by `digest.ts`. Change both sides together.
