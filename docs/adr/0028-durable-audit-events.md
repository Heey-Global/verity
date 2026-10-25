# ADR 0028 — Durable audit events

**Status:** Proposed · **Date:** 2026-10-25

**Related:** [ADR 0009](0009-brokered-secrets-and-secret-job-executor.md),
[ADR 0014](0014-acp-secret-tools-approval-gated.md), [ADR
0017](0017-docker-policy-gateway.md), [ADR
0020](0020-project-sandbox-sleep-and-automatic-wake.md), [ADR
0023](0023-multi-user-projects-and-turn-identity.md), [ADR
0025](0025-encrypted-backup-and-installer-recovery.md)

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
security history. Existing secret-event formats and verification remain
readable; any migration must explicitly reconcile their guarantees and access
rules with this proposal. No historical completeness is implied for newly
covered actions.

## Decision

### Scope and event contract

Use a shared versioned audit envelope with domain-specific, allowlisted
payloads. Record only actions Verity mediates or observes; do not claim
visibility into arbitrary shell commands or independently performed external
actions.

| Domain | Events to cover |
| --- | --- |
| Resources | Project creation/deletion, project-sandbox start/stop (sleep-initiated stops and wake-initiated starts excluded until a volume bound exists), image creation/removal and cleanup results |
| Builds | Request accepted/refused, execution started, success/failure/cancellation and produced image identity |
| Authorization | Approval decisions and grant issuance/use/revocation (legacy chain, by reference), denied sensitive requests and external actions such as push, PR creation, merge or deployment |
| Security configuration | Permission, pairing/device-access, network-exposure and isolation-policy changes; credential creation/replacement/removal by identifier only |
| System operations | Update attempts and results, Server-generation replacement, maintenance and audit-policy changes |
| Automation | Job trigger and lifecycle, linked to the resource or external action it initiates; secret jobs stay in the legacy chain and are linked by reference only |

Resource events cover the long-lived project sandbox only. Disposable query
sandboxes created for Git status reads, and similar per-command helper
containers, are not audit events: at the observed rates of tens of thousands per
day they would move container churn into the database without adding
attribution. Sleep and automatic wake under [ADR
0020](0020-project-sandbox-sleep-and-automatic-wake.md) are a further
high-frequency source; record them as sandbox lifecycle events only with an
explicit volume estimate and bound before enabling that event kind.

Each event carries a stable event ID, schema version, server-recorded UTC time,
ordered stream position, operation ID, event kind, phase and observed outcome.
Separate initiator from executor: authenticated human identity when established,
agent session/turn and its authorizing principal, or a named system job and its
trigger. Record attribution confidence/source and unknown identities explicitly;
never accept identity claims from request text as authority.

Include installation/deployment identity, Server release and generation, stable
target/project IDs, and parent operation or approval IDs where applicable. The
existing chain is keyed per project and stays the only stream for secret
approvals, grants, redemptions, job outcomes and cleanup: those events keep
their format, their co-commit guarantee and their best-effort lifecycle behavior
there and are never duplicated into a new stream. The Authorization row above
refers to them by reference, not by re-recording. New domains, including
credential creation, replacement and removal as configuration events distinct
from the recorder's job lifecycle, write to a separate per-project stream, or to
the installation-scoped stream when the credential belongs to the installation
rather than a project, so that the retention rules below for the legacy secret
chain never pin build, image or sandbox events. Events without a project, such
as updates, Server-generation replacement and audit-policy changes, form one
installation-scoped stream with its own sequence and chain head. Two records
accompany each stream and must not be confused. The *head record* holds the hash
last confirmed by a verification run; it advances only when a scheduled,
administrator-triggered or restore-triggered verification completes, never on
append, because a head that follows the tail detects nothing. A run first
confirms that the stored head's sequence and hash are still present in the chain
and fails without moving the head if they are not; the head never moves
backward, and the restore path applies the same rule before advancing heads to
restored tails. Scheduled verification covers the streams of deleted projects as
well, so their prefixes can still be pruned. Events appended after the last
verification run are the undetectable truncation window; the run cadence is part
of the audit policy. The *prune checkpoint*, introduced below, marks the removed
prefix. Both live in the same database and share its limits. Head records and
scheduled verification apply to every stream, the legacy secret chain included;
"by age alone" below refers only to the absence of operation-expired events
there. A project-scoped event caused by an installation operation references
that operation's ID; streams are not interleaved into a single global order. The
streams are pruned independently, so a reference may outlive its target, and
within one stream a later event may reference an operation or grant whose start
was pruned; verification and rendering must tolerate both kinds of dangling
reference and show them as expired rather than as corruption. Deletion must
leave enough safe target identification to interpret old events. Use bounded
fields and pagination; repository-controlled strings are untrusted input and
must be safely rendered.

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

Fail-closed applies to three groups only: Devcontainer builds, the existing
secret paths, and admin-agent reads and administrator exports of the trail.
Interactive administrator reads in the app are deliberately neither recorded nor
fail-closed in this first stage; they are limited to administrators, and
recording them would add volume without a question the trail could newly answer.
New Devcontainer builds require a committed audit intent before the build is
started, whatever triggered them: initial provisioning, the explicit rebuild
action, fleet replacement after an update, or a wake that finds no image for the
current configuration hash. Every such build executes repository and Feature
code, so the trigger does not change the rule. The rule is about image builds
Verity mediates, not about the Devcontainer path as such: agent-requested builds
through the Docker policy gateway stay denied under [ADR
0017](0017-docker-policy-gateway.md) D5 today, and if a build-worker design
later admits them they join this fail-closed group rather than the best-effort
Resources domain. Image resolution is content-addressed and a wake that finds
its image does not build; a wake that would build, and whose intent cannot be
committed, fails with an explicit audit-health error instead of running
unrecorded. Secret approvals, grant issuance and gateway-served secret calls
keep the fail-closed behavior that [ADR
0014](0014-acp-secret-tools-approval-gated.md) and the recorder already require;
this ADR does not weaken it. Admin-agent reads and administrator exports are
denied when their own audit event cannot be written, as the Access section
specifies. All other events, including pushes, pull-request creation, merges,
deployments, permission and exposure changes, are recorded best-effort: the
action proceeds when the audit write fails, and the failure is surfaced as
degraded audit health. Pushes, pull requests, merges and deployments are
observed only indirectly, through the credential helper or a connector, and
blocking them during an audit outage would stop all agent work for a guarantee
the trail cannot fully provide anyway. Permission and exposure changes are
different: they are database transitions Verity mediates directly and could
co-commit cheaply. They stay best-effort in this first stage as a deliberate
choice to keep the fail-closed set small and reviewable; the accepted cost is
that an induced audit outage leaves such a change evidenced only by the gap
event and the resulting state. Moving them into the fail-closed set is the first
candidate for an amendment once the build and secret paths have run in
production.

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
failure, including for builds and secret jobs already running. This exception
does not authorize arbitrary new work or silent retention shortening. Attempt
to record these actions, visibly report degraded audit health through an
independent operational diagnostic, and never claim missing events were saved.
Completed external effects cannot be rolled back merely because writing their
outcome failed.

A best-effort write that fails leaves no row, and no chain can detect an event
that was never appended. Each Server process counts its own failed writes per
stream and domain in memory and, once storage recovers, appends a *write-gap*
event with those counts and the failure window to each affected stream before
that process appends anything else to it. Several processes may write at once,
for example during generation replacement, so no cross-process gate is
attempted: the write-gap event is ordered only relative to its own process's
later events, and its failure window, not its stream position, says which period
it covers. Readers correlate gap events with other processes' events by
server-recorded time. Write-gap tracking applies to the new streams only. The
legacy secret chain does not participate in it: its post-commit lifecycle events
keep their existing best-effort behavior, no new event kind is added to its
format, and a co-committed secret approval never waits on write-gap bookkeeping.
Recovery may add reconciliation events describing only what is known. The
audit-health diagnostic is a live process signal, not durable storage: when the
process dies before recovery, the gap can go completely unevidenced. That is an
accepted limitation of the local-only first stage and one reason external copies
remain a later decision.

### Access

Only instance administrators may read and export the complete trail. Project
membership alone grants no access, including to that project's events.
Server-authorized agent contexts acting for a currently authorized administrator
may read through a bounded, read-only API/tool. Authenticate the current turn's
principal and re-check authority on every read; session ownership, a prompt's
claim or a reusable project token is insufficient. This depends on the per-turn
identity of [ADR 0023](0023-multi-user-projects-and-turn-identity.md); the
`users` role table exists, but until turn identity is in place agent reads stay
disabled rather than falling back to session ownership. If reliable admin
attribution is unavailable, deny the agent read. Revocation or a subsequent
non-admin turn must remove access without waiting for the session to end.

Do not expose database credentials or audit mounts to project containers.
Agent access grants no event editing, deletion or retention-policy authority.
Treat returned audit strings as untrusted data, never as instructions. Record
administrator exports as events with safe query scope metadata. Read and
export events are written to the installation-scoped stream and reference the
projects they covered, because one read may span several project streams. Record
admin-agent reads once per turn, written when the turn's first read is granted
and before results are returned, so a crashed turn still leaves evidence and
an investigating agent cannot inflate the trail with repeated queries. The
event names the administrator, the agent session and turn, and the stream,
project and time scope actually requested so far; a later read that widens
that requested scope appends a new event, up to a bounded number of scope
widenings per turn; beyond that bound further widening is denied until a new
turn. Agent reads and administrator exports are fail-closed: when the read or
export event cannot be written, the request is denied, since investigation
can wait but an untraced read of the trail cannot be repaired. Avoid recursive
logging of the audit recorder itself. No client-facing read path for
secret-audit events exists today, so administrator-only access removes no
existing project-member capability.

### Local storage, retention and integrity

Store events in the existing Verity PostgreSQL database, independent of Server
container lifetime. Reuse safe projections and chain-verification conventions;
extend domain coverage without rewriting existing historical payloads.
Use project and installation scopes without cascading deletion from live
projects, sessions or user records. Application writes append events; there is
no ordinary edit or selective-delete API.

Default retention is 180 days, configurable by an administrator. The existing
secret-audit chain is never pruned today and its verification re-derives every
event from sequence zero. Rows recorded before this ADR's rollout therefore keep
unbounded retention until an administrator explicitly confirms the window, once
and installation-wide, after a disclosure of how many pre-existing events it
removes across all projects; the upgrade itself must not prune them. An
installation with no pre-rollout secret events needs no confirmation and applies
the default from the start. Because pruning removes a contiguous prefix, the
whole per-project secret chain, including rows written after rollout, stays
pinned until that confirmation; the 180-day default applies to secret-audit
chains only from then on. From that confirmation on, secret-audit events are
pruned once prune-checkpoint support exists, by age alone: the legacy chain gets
no operation-expired event kind, so an unterminated grant or job older than the
window is removed with its prefix and stays indeterminate under the recorder's
existing semantics. Verification treats that as a declared expired prefix, not
as corruption. Retired request-MAC keys are kept at least until every event
signed under them has expired, so retained events stay verifiable. Project
deletion does not shorten retention; today it already leaves secret-audit rows
untouched. Policy changes are audited; shortening the window must explicitly
disclose that older history will be removed. Retention uses server-recorded
time, not a caller-supplied timestamp. On the new streams it must not split an
operation that is still active; the legacy secret chain is pruned by age alone,
as stated above. An operation without a terminal result cannot pin its stream
forever: after a bounded, configurable overrun past the window, reconciliation
appends an *operation-expired* event that closes it as indeterminate, and the
prefix advances; this is a distinct event kind from the write-gap event above. A
terminal result observed after that closure is appended as reconciliation
evidence under the same operation ID and supersedes the expired marker in
rendering; it is never rejected and never invented. If the prefix holding that
operation's start was already pruned, rendering shows the late result against an
expired reference, not as corruption, and the late event does not re-pin
retention for the removed start. The prune boundary stays strictly below the
stream's verified head record: the event the head points to is always retained,
so the presence check of the next verification run can succeed, and a
verification run is required before pruning can advance further. The overrun is
part of the audit policy and is itself audited.

Retention is a controlled exception to append-only storage. Before deleting an
expired contiguous prefix, persist a prune checkpoint with stream identity,
removed sequence range and boundary hash; preserve the retained suffix's
original sequence and hashes. Commit deletion and checkpoint advancement
atomically and serialize them with appends. Verification must distinguish a
declared expired prefix from corruption and report its available coverage.
Keep only bounded checkpoint metadata, not expired payloads. Do not reset
chains silently. Existing verification APIs need explicit prune-checkpoint
support before pruning is enabled; head records exist from rollout. Exact
schema/index/batching choices belong to implementation design.

Database backups must include events, head records, prune checkpoints and
required verification/key metadata. This ADR does not assert that the proposed
backup system in [ADR 0025](0025-encrypted-backup-and-installer-recovery.md) is
implemented. Document how an installation's actual backup procedure covers these
records. A restore only contains history through its snapshot: display the
snapshot time as the trail's coverage boundary, record the restore as a new
operational lineage when possible, and never replay recorded actions. Because
head records are restored with the snapshot, events written after it vanish
without detectable truncation; the trail cannot disclose what was lost, only
where its coverage ends. Where pruning is enabled, a restore first runs
verification on every stream, advancing head records to the restored tails. A
stream whose verification fails is marked unverified: its head and pruning stay
frozen, its reads carry that mark and hide rows that are expired under the
snapshot's policy until an administrator resolves the stream, while every other
stream proceeds, so a damaged backup never turns into an audit-wide outage. The
restore then prunes data expired under the retention policy contained in the
snapshot before ordinary audit reads resume; before pruning exists, restored
data is simply readable. Backup copies and exported files have independent
lifetimes; deleting live rows does not erase older backups or exports.

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
rollout. A full database may also prevent application state changes
independently of audit policy. Emergency stop/cancel paths require explicit
failure testing. Audit history is evidence of observed events, not proof of
intent, complete external activity or protection against a fully compromised
host.

## Rollout and verification requirements

Begin with Devcontainer builds and image lifecycle, connecting initiator,
project, source revision, build operation and output image across updates and
deletion. Then integrate resource lifecycle and system maintenance, and connect
remaining security/external-action domains to the shared envelope. Preserve
existing secret-audit requirements throughout. Publish an explicit coverage
matrix so unimplemented event kinds are not implied by the presence of an audit
screen.

Before enabling each domain, verify:

- A Server-generation replacement preserves events and correlates build/image
  IDs; project deletion leaves the history readable until retention expires.
- Failed intent writes prevent new builds and keep the existing secret-audit
  paths fail-closed; best-effort events let the action proceed and raise
  degraded audit health. Fail-closed database transitions co-commit with their
  audit entries; best-effort transitions do not roll back on an audit write
  failure. Emergency stop/cancel/cleanup remains usable.
- Disposable query sandboxes produce no audit events; a day of status polling
  adds no rows.
- An admin-agent read or administrator export is denied when its own audit event
  cannot be written; scope widening beyond the per-turn bound is denied.
- An operation without a terminal result is closed as indeterminate after the
  configured overrun, and a later observed result supersedes that marker without
  being rejected or duplicated.
- A verification run fails, and the head record stays put, when the stored head
  is missing or its hash differs; the head never moves backward.
- After audit storage recovers from failed best-effort writes, the recovering
  process appends its write-gap event to each affected stream before any other
  event of its own; other processes and streams are unaffected.
- Crash windows and uncertain external outcomes remain indeterminate; retries
  and reconciliation never duplicate the external effect or invent attribution.
- Non-admin users and agents cannot read; current admin agents can read only;
  role revocation and turn identity changes immediately remove that access.
- Secret-bearing, malformed and oversized inputs never leak through payloads,
  fingerprints, errors or exports; audit data cannot become agent instructions.
- Concurrent append/prune, policy changes and interrupted retention preserve
  verifiable suffixes and accurately declared expired coverage.
- Backups/restores preserve keys, head records and prune checkpoints, display
  the snapshot coverage boundary and do not execute historical work. Records
  expired under the restored snapshot's own retention policy are not resurfaced,
  by pruning on verified streams and by hiding on unverified ones; a policy
  change made after the snapshot is itself lost with it.
- Tampering with, removal of, or truncation of events up to the last verified
  head record is detected; the window after that run is documented as
  undetectable. A write-gap event covers best-effort writes that failed while
  the process survived. No protection is claimed against replacement of all
  local state or against events that were never written.

Runtime schemas, migrations, routes/tools, UI and retention workers require a
separately reviewed implementation. This ADR alone enables none of them.

## References

- [Brokered secrets](0009-brokered-secrets-and-secret-job-executor.md)
- [Approval-gated ACP secret tools](0014-acp-secret-tools-approval-gated.md)
- [Docker policy gateway](0017-docker-policy-gateway.md)
- [Project sandbox sleep and automatic wake](0020-project-sandbox-sleep-and-automatic-wake.md)
- [Multi-user projects and turn identity](0023-multi-user-projects-and-turn-identity.md)
- [Encrypted backup and installer recovery](0025-encrypted-backup-and-installer-recovery.md)
