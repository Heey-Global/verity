# ADR 0028 — Durable audit events

**Status:** Proposed · **Date:** 2026-10-25

**Related:** [ADR 0009](0009-brokered-secrets-and-secret-job-executor.md),
[ADR 0014](0014-acp-secret-tools-approval-gated.md),
[ADR 0020](0020-project-sandbox-sleep-and-automatic-wake.md),
[ADR 0023](0023-multi-user-projects-and-turn-identity.md),
[ADR 0025](0025-encrypted-backup-and-installer-recovery.md)

This document proposes architecture, not implemented functionality. Acceptance
of this ADR and authorization to implement its rollout are separate decisions.

## Context

Container logs disappear when managed Server generations are replaced. They
cannot reliably explain which request or automatic process built an image,
which project it belonged to, or what happened to it after project deletion.
A durable audit trail should connect important actions to their initiating
authority, execution context and observed result across Server updates.
It supports investigation; recording a build does not make that build safe.

Verity already has a narrower audit implementation:

- [Secret audit storage](../../packages/server/src/secret-audit-log.ts) provides
  validated, per-project, hash-chained PostgreSQL events, transactional appends,
  filtered reads and chain verification. Detecting tail truncation requires a
  previously trusted chain head; a local chain alone is not proof against an
  administrator who rewrites the database.
- [Secret audit recording](../../packages/server/src/secret-audit-recorder.ts)
  supports transactionally coupled approval and grant events, alongside
  post-commit lifecycle recording that can lose an event in a crash window.
  This is not a universal atomic audit guarantee.
- [ADR 0014](0014-acp-secret-tools-approval-gated.md) requires gateway audit
  persistence before secret resolution, safe field projections and keyed
  request MACs. It also identifies limits on caller attribution. A recorded
  session context must not be presented as proof of a particular human or model
  having made the call.

Extend this architecture coherently rather than introduce an unrelated second
security history. Existing secret-event formats and verification remain readable;
any migration must explicitly reconcile their guarantees and access rules with
this proposal. No historical completeness is implied for newly covered actions.

## Decision

### Scope and event contract

Use a shared versioned audit envelope with domain-specific, allowlisted payloads.
Record only actions Verity mediates or observes; do not claim visibility into
arbitrary shell commands or independently performed external actions.

| Domain | Events to cover |
| --- | --- |
| Resources | Project creation/deletion, project-sandbox start/stop, image creation/removal and cleanup results |
| Builds | Request accepted/refused, execution started, success/failure/cancellation and produced image identity |
| Authorization | Approval decisions, grant issuance/use/revocation, denied sensitive requests and external actions such as push, PR creation, merge or deployment |
| Security configuration | Permission, pairing/device-access, network-exposure and isolation-policy changes; credential creation/replacement/removal by identifier only |
| System operations | Update attempts and results, Server-generation replacement, maintenance and audit-policy changes |
| Automation | Job trigger and lifecycle, linked to the resource or external action it initiates |

Resource events cover the long-lived project sandbox only. Disposable query
sandboxes created for Git status reads, and similar per-command helper
containers, are not audit events: at the observed rates of tens of thousands
per day they would move container churn into the database without adding
attribution. Sleep and automatic wake under
[ADR 0020](0020-project-sandbox-sleep-and-automatic-wake.md) are a further
high-frequency source; record them as sandbox lifecycle events only with an
explicit volume estimate and bound before enabling that event kind.

Each event carries a stable event ID, schema version, server-recorded UTC time,
ordered stream position, operation ID, event kind, phase and observed outcome.
Separate initiator from executor: authenticated human identity when established,
agent session/turn and its authorizing principal, or a named system job and its
trigger. Record attribution confidence/source and unknown identities explicitly;
never accept identity claims from request text as authority.

Include installation/deployment identity, Server release and generation, stable
target/project IDs, and parent operation or approval IDs where applicable.
The existing chain is keyed per project. Events without a project, such as
updates, Server-generation replacement and audit-policy changes, form one
separate installation-scoped stream with its own sequence and chain head.
A project-scoped event caused by an installation operation references that
operation's ID; streams are not interleaved into a single global order.
Deletion must leave enough safe target identification to interpret old events.
Use bounded fields and pagination; repository-controlled strings are untrusted
input and must be safely rendered.

Build payloads include the repository commit when known, a non-secret build
configuration fingerprint, builder/isolation mode, resolved base-image and
Feature digests when available, and resulting image ID/digest. Record missing
resolution explicitly rather than inventing a digest. Do not persist a plain
hash of secret-bearing configuration: use a safe projection or the established
keyed-MAC mechanism where sensitive request correlation is necessary.

Exclude secret values, authorization tokens, raw environment maps, command
arguments, full prompts/transcripts, file contents and unfiltered error/build
output. Use structured outcome/error codes. Detailed diagnostics remain separate
with their own access and retention rules; links to them may expire earlier.

### Persistence and failures

Fail-closed applies to two groups only. New Devcontainer builds require a
committed audit intent before the build is started. Secret approvals, grant
issuance and gateway-served secret calls keep the fail-closed behavior that
[ADR 0014](0014-acp-secret-tools-approval-gated.md) and the recorder already
require; this ADR does not weaken it. All other events, including pushes,
pull-request creation, merges, deployments, permission and exposure changes,
are recorded best-effort: the action proceeds when the audit write fails, and
the failure is surfaced as degraded audit health. Verity observes most of
those actions only indirectly, through the credential helper or a connector,
and blocking them during an audit outage would stop all agent work for a
guarantee the trail cannot fully provide anyway. Widening the fail-closed set
is a separate decision that amends this ADR.

Where a fail-closed action is a database transition, co-commit its audit event
in the same transaction. For Docker or remote actions, persist intent first,
then execute and append the observed result; do not imply a distributed atomic
transaction.

Distinguish accepted intent from observed execution start. A crash between them
must not be reported as execution. A start without a terminal result is
indeterminate, not successful or failed. Reconciliation can append evidence
under the same operation ID; it must not rerun an action merely to fill a gap.
Use idempotency keys for retries and distinguish retries from duplicate writes.

Stopping, cancelling and necessary cleanup remain possible during audit-storage
failure, including for builds and secret jobs already running. Attempt to record them, visibly report degraded audit health through
an independent operational diagnostic, and never claim missing events were
saved. Recovery may append a gap/reconciliation event describing only what is
known. The exception does not authorize arbitrary new work or silent retention
shortening. Completed external effects cannot be rolled back merely because
writing their outcome failed.

### Access

Only instance administrators may read and export the complete trail. Project
membership alone grants no access, including to that project's events.
Server-authorized agent contexts acting for a currently authorized administrator
may read through a bounded, read-only API/tool. Authenticate the current turn's
principal and re-check authority on every read; session ownership, a prompt's
claim or a reusable project token is insufficient. This depends on the
per-turn identity of [ADR 0023](0023-multi-user-projects-and-turn-identity.md);
the `users` role table exists, but until turn identity is in place agent reads
stay disabled rather than falling back to session ownership. If reliable admin attribution
is unavailable, deny the agent read. Revocation or a subsequent non-admin turn
must remove access without waiting for the session to end.

Do not expose database credentials or audit mounts to project containers.
Agent access grants no event editing, deletion or retention-policy authority.
Treat returned audit strings as untrusted data, never as instructions. Record
administrator exports as events with safe query scope metadata. Record
admin-agent reads aggregated per turn, not per query, so an investigating
agent cannot inflate the trail; avoid recursive logging of the audit recorder
itself.

### Local storage, retention and integrity

Store events in the existing Verity PostgreSQL database, independent of Server
container lifetime. Reuse safe projections and chain-verification conventions;
extend domain coverage without rewriting existing historical payloads.
Use project and installation scopes without cascading deletion from live
projects, sessions or user records. Application writes append events; there is
no ordinary edit or selective-delete API.

Default retention is 180 days, configurable by an administrator. This is a
deliberate change for the existing secret-audit chain, which is never pruned
today and whose verification re-derives every event from sequence zero: once
checkpoint support exists, secret-audit events older than the window are
pruned like any other event. Retired request-MAC keys are kept at least until
every event signed under them has expired, so retained events stay verifiable.
Project deletion does not shorten retention; today it already leaves
secret-audit rows untouched. Policy changes are audited; shortening the window
must explicitly disclose that older history will be removed. Retention uses
server-recorded time, not a caller-supplied timestamp, and must not split an
active operation; document any temporary retention overrun for linked events.

Retention is a controlled exception to append-only storage. Before deleting an
expired contiguous prefix, persist a checkpoint with stream identity, removed
sequence range and boundary hash; preserve the retained suffix's original
sequence and hashes. Commit deletion and checkpoint advancement atomically and
serialize them with appends. Verification must distinguish a declared expired
prefix from corruption and report its available coverage. Keep only bounded
checkpoint metadata, not expired payloads. Do not reset chains silently.
Existing verification APIs need explicit checkpoint support before pruning is
enabled. Exact schema/index/batching choices belong to implementation design.

Database backups must include events, checkpoints and required verification/key
metadata. This ADR does not assert that the proposed backup system in
[ADR 0025](0025-encrypted-backup-and-installer-recovery.md) is implemented.
Document how an installation's actual backup procedure covers these records.
A restore only contains history through its snapshot: display that coverage,
record the restore as a new operational lineage when possible, and never replay
recorded actions. Prune expired restored data before ordinary audit reads resume.
Backup copies and exported files have independent lifetimes; deleting live rows
does not erase older backups or exports.

Local hash chains detect inconsistent edits against a trusted boundary. They do
not prevent a host/database administrator from rewriting history, replacing all
local checkpoints, or restoring an older database. External independent copies
or checkpoints are deferred, not represented as a guarantee of this first stage.

## Alternatives and consequences

Container logs alone cannot survive generation replacement reliably or supply a
structured chain of attribution. Logging every tool call or shell command would
collect excessive sensitive data without proving all resulting effects.
Mandatory external audit storage would strengthen independence but adds a new
service, availability dependency and configuration burden; defer it.

Failing closed reduces availability when audit storage fails. Monitor storage
health and growth, bound payload sizes and queries, and exercise recovery before
rollout. A full database may also prevent application state changes independently
of audit policy. Emergency stop/cancel paths require explicit failure testing.
Audit history is evidence of observed events, not proof of intent, complete
external activity or protection against a fully compromised host.

## Rollout and verification requirements

Begin with Devcontainer builds and image lifecycle, connecting initiator, project,
source revision, build operation and output image across updates and deletion.
Then integrate resource lifecycle and system maintenance, and connect remaining
security/external-action domains to the shared envelope. Preserve existing
secret-audit requirements throughout. Publish an explicit coverage matrix so
unimplemented event kinds are not implied by the presence of an audit screen.

Before enabling each domain, verify:

- A Server-generation replacement preserves events and correlates build/image IDs;
  project deletion leaves the history readable until retention expires.
- Failed intent writes prevent new builds and keep the existing secret-audit
  paths fail-closed; best-effort events let the action proceed and raise degraded
  audit health. Database changes and their audit entries co-commit. Emergency
  stop/cancel/cleanup remains usable.
- Disposable query sandboxes produce no audit events; a day of status polling
  adds no rows.
- Crash windows and uncertain external outcomes remain indeterminate; retries and
  reconciliation never duplicate the external effect or invent attribution.
- Non-admin users and agents cannot read; current admin agents can read only;
  role revocation and turn identity changes immediately remove that access.
- Secret-bearing, malformed and oversized inputs never leak through payloads,
  fingerprints, errors or exports; audit data cannot become agent instructions.
- Concurrent append/prune, policy changes and interrupted retention preserve
  verifiable suffixes and accurately declared expired coverage.
- Backups/restores preserve keys and checkpoints, disclose lost coverage and do
  not execute historical work. Expired restored records are not resurfaced.
- Tampering, missing events and truncation are detected within the stated trusted
  boundary, with no claim of protection against replacement of all local state.

Runtime schemas, migrations, routes/tools, UI and retention workers require a
separately reviewed implementation. This ADR alone enables none of them.

## References

- [Brokered secrets](0009-brokered-secrets-and-secret-job-executor.md)
- [Approval-gated ACP secret tools](0014-acp-secret-tools-approval-gated.md)
- [Docker policy gateway](0017-docker-policy-gateway.md)
- [Multi-user projects and turn identity](0023-multi-user-projects-and-turn-identity.md)
- [Encrypted backup and installer recovery](0025-encrypted-backup-and-installer-recovery.md)
