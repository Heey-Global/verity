# Coordinated Core and Uplink team delivery

**Status:** Proposed plan, not an implementation or release claim.

Contracts: [Core ADR 0023](adr/0023-multi-user-projects-and-turn-identity.md),
[team protocol draft](protocols/uplink-team-sharing-v1.md), and
[base channel protocol](UPLINK_CHANNEL_PROTOCOL.md).
The private companion is titled “Uplink team sharing and entitlement brokerage”.

## Ownership and change discipline

The public protocol document is the source of truth for interoperability.
The private service references an exact reviewed Core commit, never a floating
copy of the contract. Contract changes link a Core task and Uplink task with
the same T-number below. Each task names its counterpart, contract revision,
acceptance vectors and compatible versions. These are planning IDs, not GitHub
issues already created.

The initial coordinated review must inspect the private service's existing
handshake, identity, entitlement and invitation models. That repository was
not available while drafting; endpoint names and signature profile are not
claimed to be agreed with its implementation. Resolve differences in the
public contract before parallel implementation, not in undocumented adapters.

## Work packages

| ID  | Core / app / public protocol                                                                                  | Private Uplink                                                                                                                                                                                                     | Joint completion gate                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| T0  | Freeze identity mapping, negotiation, bootstrap proof, signing profile and error schema                       | Review existing service compatibility; select issuance, key rotation and retention policy, including the retry window, late-message age bounds and removal tombstone retention (permanent until those bounds hold) | Both sides approve one revision; resolve all protocol freeze blockers                   |
| T1  | Publish strict schemas, test-only signing fixtures and executable vector runner; simulator                    | Consume the same pinned fixtures and run against service handlers                                                                                                                                                  | V01–V30 have executable coverage; negative guards demonstrably fail when broken         |
| T2  | Migrate local users/devices, project permissions, audits and per-user connection ownership; multi-profile app | No core credential handling; prepare scoped service identity bindings                                                                                                                                              | Single-user regression checks pass; three profiles remain isolated                      |
| T3  | Isolate per-user/project runtimes and grants; shared files/history; test stale resume and backend changes     | Supply grant issuance/renewal/revocation and state reconciliation                                                                                                                                                  | Correct credentials on alternating and concurrent sessions; stale identity rejected     |
| T4  | Implement invitation transaction, outbox, member device bootstrap and onboarding                              | Broker create/cancel/reserve/commit with idempotent recovery                                                                                                                                                       | Invite → join → personal connection → first turn works; V08–V13, V24 pass               |
| T5  | Enforce direct/relayed membership checks, expiry and revocation; visible app states                           | Enforce relay entitlement, reconcile revocations and apply membership removal tombstones, renew grants                                                                                                             | Restart/outage/expiry/removal matrix, including V19–V30, passes on both real components |
| T6  | Ship gated client support and staged activation                                                               | Deploy compatible service first                                                                                                                                                                                    | Version matrix and full end-to-end acceptance pass before enabling teams                |

T0 precedes implementation of the wire contract. T1 follows the frozen contract.
T2 can start independently after ADR approval; T3 depends on its principal model.
T4 needs T1–T3. T5 validates their integration and must implement the missing Remote Control
session-admission flow on both sides; tickets and streams alone do not provide it. None enables multi-user execution
before authorization and runtime isolation are complete. Federation is excluded.

## Preview-name change within T0/T1/T6

Use `preview-sharing` as the preview capability at T0 and remove `sharing` from
the target contract. No running installations require compatibility with the
old name, so there is no alias or transition period. T1 covers the V01 naming
and renewal cases. T6 ensures both client and service use the new name before
release. Future deployed version compatibility remains a separate requirement.
This plan does not change the deployed client or service by itself.

## Test environments and release evidence

The simulator runs only in tests and uses explicitly test-owned trust keys.
Production constructors must not trust those keys or allow a simulator flag to
bypass entitlement validation. Unit/contract suites require no paid account.
Both repositories pin the same fixture revision and report its identifier.

A separate staging environment connects the actual core, app and hosted Uplink
with synthetic accounts and projects. Use two members with different provider
connections, at least one member without GitHub, and three server profiles.
Exercise the full onboarding and turn flow, then repeat with control disconnect,
service restart, core restart, expired grant, explicit revocation and membership
removal. Verify content survives suspension and another user's credentials are
never selected. Use test provider stubs for automated cost-sensitive runs, plus
an explicitly provisioned provider smoke where needed; no production secrets
belong in fixtures or artifacts.

| Core                                    | Uplink                             | Required behavior                                             |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| Existing client without extension       | New service                        | Existing preview/personal features continue                   |
| New client                              | Existing service without extension | Clear team-unavailable state; existing features continue      |
| New client, team v1                     | New service, team v1               | All contract vectors and real end-to-end flow pass            |
| Future current / previous team versions | Service supporting N/N−1           | Explicit negotiation; no implicit downgrade into wider rights |

Publish the test evidence and pinned revisions in each release's review record.
Service support ships first, then gated core/app support. Activation is last.
Rollback disables team admission and suspends access safely; it must not drop
membership tables, rewrite identities or silently restore single-user global
credential routing. Database migrations remain readable during the agreed
rollback window. Numeric grace/retention periods must be frozen at T0, not
chosen independently by each implementation.

The compatibility rows above assume the coordinated pre-deployment
`preview-sharing` rename on both sides. They do not promise interoperability
with the retired `sharing` spelling or require an alias.

## Immediate handoff

Core next deliverable: T0 review followed by T1 schema/fixture implementation.
Private-service next deliverable: review this contract and the companion against
its actual code, then identify paired T0/T1 tasks. Until that review is possible,
the protocol stays Proposed. This plan does not create remote issues, provision
staging, enable a paid feature, or deploy either service.
