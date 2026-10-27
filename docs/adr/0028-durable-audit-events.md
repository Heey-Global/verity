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
target/project IDs, and parent operation or approval IDs where applicable.

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

Fail-closed applies to four groups only: Devcontainer builds, the existing
secret paths, admin-agent reads and administrator exports of the trail, and
relaxing changes to the trail's own policy or integrity state: retention and
overrun changes, the legacy-prune confirmation, head advancement and the
resolution of an unverified stream. Tightening transitions, such as marking a
stream unverified and freezing its pruning, always apply even when their audit
event cannot be written; the mark itself is stored state, and the next
successful run re-derives the pending event from it, so an induced outage delays
the record but cannot suppress detection. Head advancement and the other events
about a stream's integrity are written to the installation stream, one per
stream and run and only when the head actually moves, so a quiet stream whose
tail has not changed produces no event and the legacy chain's format is
untouched; restore-triggered advancement follows the same rule. The installation
stream's own head advancement is recorded by its head record alone and never by
an event, and is therefore exempt from the fail-closed rule, and events written by a run do not count as tail movement for that
run's successor, so verification does not feed itself and the installation
stream stays quiet when nothing else happens. The write-gap append is
additionally fail-closed for the recovering process alone, as described below.
Retention and overrun changes and the one-time legacy-prune confirmation are
database transitions that delete history, so they co-commit with their audit
event and are refused when it cannot be written. Interactive administrator reads
in the app are deliberately neither recorded nor fail-closed in this first
stage; they are limited to administrators, and recording them would add volume
without a question the trail could newly answer. New Devcontainer builds require
a committed audit intent before the build is started, whatever triggered them:
initial provisioning, the explicit rebuild action, fleet replacement after an
update, or a wake that finds no image for the current configuration hash. Every
such build executes repository and Feature code, so the trigger does not change
the rule. The rule is about image builds Verity mediates, not about the
Devcontainer path as such: agent-requested builds through the Docker policy
gateway stay denied under [ADR 0017](0017-docker-policy-gateway.md) D5 today,
and if a build-worker design later admits them they join this fail-closed group
rather than the best-effort Resources domain. Image resolution is
content-addressed and a wake that finds its image does not build; a wake that
would build, and whose intent cannot be committed, fails with an explicit
audit-health error instead of running unrecorded. Secret approvals, grant
issuance and gateway-served secret calls keep the fail-closed behavior that [ADR
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
server-recorded time, which is the database-assigned time of each stored event;
the failure window inside a gap event is necessarily measured on the process
clock and is labelled as such. For the recovering process the gap event is
effectively fail-closed: while it cannot be written, that process's fail-closed
intents on the stream are refused too, and other processes are unaffected. A
stream marked unverified still accepts appends, since the mark concerns retained
history and not new events; those appends are verified from the declared
boundary once the stream is resolved. Write-gap tracking applies to the new
streams only. The legacy secret chain does not participate in it: its
post-commit lifecycle events keep their existing best-effort behavior, no new
event kind is added to its format, and a co-committed secret approval never
waits on write-gap bookkeeping. Recovery may add reconciliation events
describing only what is known. The audit-health diagnostic is a live process
signal, not durable storage: when the process dies before recovery, the gap can
go completely unevidenced. That is an accepted limitation of the local-only
first stage and one reason external copies remain a later decision.

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

Do not expose database credentials or audit mounts to project containers. Agent
access grants no event editing, deletion or retention-policy authority. Treat
returned audit strings as untrusted data, never as instructions. Record
administrator exports as events with safe query scope metadata. An export is the
generation of a file or a bulk download; interactive, paginated reads in the app
are not exports. Export events therefore trace what left the system as a file,
and are not an access-accounting control over administrators, who can page
through the trail unrecorded. Read and export events are written to the
installation-scoped stream and reference the projects they covered, because one
read may span several project streams. Record admin-agent reads once per turn,
written when the turn's first read is granted and before results are returned,
so a crashed turn still leaves evidence and an investigating agent cannot
inflate the trail with repeated queries. The event names the administrator, the
agent session and turn, and the stream, project and time scope actually
requested so far; a later read that widens that requested scope appends a new
event, up to a bounded number of scope widenings per turn; beyond that bound
further widening is denied until a new turn. Agent reads and administrator
exports are fail-closed: when the read or export event cannot be written, the
request is denied, since delegated or prompt-driven access to the trail is the
threat these events exist to trace, and investigation by an agent can wait until
the trace can be written. Avoid recursive logging of the audit recorder itself.
No client-facing read path for secret-audit events exists today, so
administrator-only access removes no existing project-member capability.

### Presentation

The app shows the trail as an **Audit logs** row in the Server group of
Settings, next to Updates, and only to administrators. Following the existing
settings rows, its subtitle names what the trail contains for the enabled
domains (for the first stage: builds, secret access and server updates) and it
carries no status while the trail is healthy. Degraded audit health (writes
currently failing) or an unresolved unverified stream gives the row a
`needsSetup` status (“Needs review”), so a problem with the trail is visible
without opening it; a past write-gap stays visible in the list but no longer
marks the row once writes succeed again. Project settings get no entry point,
because project membership grants no access; later contextual links, for
example from a project image, open the same filtered view for administrators.

The list shows one row per operation, grouped by day and newest first, not one
row per stored event. Each row is built from the
[design system](../design-system.md):

- **Icon:** one fixed line icon per domain, drawn in `action` because every row
  opens its detail. Color never encodes the domain, and `signature` is not used.
  An `attention` icon is reserved for problems with the trail itself: a
  write-gap, shown as its own row at its failure window (“3 events not
  recorded”), and an unverified stream, shown as a row above the list that names
  the project and the date of the failed check.
- **Title:** what happened, in the terms the app already uses (“Project image
  built”, “Secret approved”, “Server updated”); Devcontainer, stream, chain,
  head and sequence are implementation terms and never appear.
- **Subtitle:** project, the concrete initiator (session title, “You”, sandbox
  wake, server update) and time.
- **Status:** a completed operation with its expected outcome shows no status
  word. Only deviations do: running (`transient`), failed, denied or refused
  (`needsSetup`) and indeterminate (“Unknown”). The status intents have no
  mapping for an unknown outcome yet; the design system needs that addition
  before the screen is built, rather than borrowing `optional`, whose meaning
  differs.

Search covers image ID or digest, project and operation ID, so an administrator
who finds an unexplained image can go straight to the build that produced it.
Filters follow the enabled domains. Export is a header action, recorded as
described under Access. The footer states the retention boundary (“Entries since
…”), which explains why older history is absent.

The detail of an operation shows one status tag with the time range, then only
what answers who started it, what it was built from and what it produced:
initiator and project as links (shown as expired when the target is gone),
commit, base image and Feature digests, resulting image and size, Server release
and generation, and a copyable operation ID. Configuration fingerprints, stream
positions and verification metadata stay in exports and are not shown.

### Stream integrity and verification

The existing chain is keyed per project and stays the only stream for secret
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
installation-scoped stream with its own sequence and chain head.

Two records accompany each stream and must not be confused. The *head record*
holds the hash last confirmed by a verification run; it advances only when a
scheduled, administrator-triggered or restore-triggered verification completes,
never on append, because a head that follows the tail detects nothing. A run
first confirms that the stored head's sequence and hash are still present in the
chain. If they are not, or the chain does not re-derive, the run fails without
moving the head, the stream is marked unverified, its pruning freezes, its reads
carry the mark and hide rows that are expired under the policy in force, which
after a restore is the snapshot's, audit health reports the failure, and an
administrator must resolve the stream explicitly; the restore path below reuses
this handling.

Resolution is itself a fail-closed, co-committed audit event on the installation
stream that names the stream and the chosen outcome; the declared boundary is
always the failure point recorded by the failed run, the resolution event
follows every append made since then, and the re-derived head covers those
appends, so an installation-stream failure, whose stream keeps receiving read,
export and policy events meanwhile, has the same defined way out as any other:
either a fresh full re-derivation succeeds while the previously trusted head
(sequence and hash) is still present and matches, and re-anchors the head, or
the administrator declares the mismatch as an accepted gap and the head is
re-anchored at the current tail with that declaration attached; when the
resolved stream is the installation stream, the resolution event itself is that
tail, so the head points at it. A missing or mismatched head can only be
resolved as an accepted gap: a truncated or consistently rewritten chain
re-derives cleanly, so a clean re-derivation proves nothing about it. Every
resolution event records the old head's sequence and hash.

After any resolution the head takes the sequence of the current tail, which
includes every append made since the failure. When that sequence is lower than
the previous head, as after a truncated tail on a quiet stream, the head has
moved backward; that is the one permitted case, and the resolution event records
both sequences so the check is deterministic; sequence numbers are never reused
within one restore lineage. The implementation design must therefore keep a
per-stream allocation counter that is separate from the verified-head hash,
advances on every append and is seeded at migration for live and deleted
projects, and it must teach the legacy chain's verification that a declared
boundary, not only the previous sequence, may precede an event. Those are
required changes to the legacy append and verify paths; the legacy event format
and kinds stay as they are, and any extra locking the counter needs is measured
against the fail-closed latency of ADR 0014 before rollout. Every later position
is attributable to its restore lineage, for legacy rows as well; whether that is
a column or a side table keyed by sequence range is an implementation choice,
but the attribution is required, so a citation made before a restore names a
position in the earlier lineage rather than colliding with a later one. The
declaration is a recognized verification boundary like a prune checkpoint, but
it does not skip history: later runs still re-derive every retained segment
between consecutive boundaries against that segment's own anchor, and only the
declared mismatch point itself is exempt, so an accepted gap stays verified
without opening an unverified hole and never re-freezes the stream by itself.
The detection claim below excludes the declared point and nothing else.
Resolution applies to the streams of deleted projects as well, so one broken
chain cannot block legacy pruning indefinitely. While resolving, the
administrator sees the hidden expired rows; only ordinary reads hide them.

The first head of every stream is set only by a
successful verification from sequence zero or from the prune checkpoint: an
upgrade seeds no head from a tail it has not verified, a pre-existing chain that
fails is marked unverified at upgrade, and a new or empty stream starts with a
genesis head. The legacy-prune confirmation is unavailable while any legacy
chain is unverified. Otherwise the head never moves backward, and the restore
path applies the same rule before advancing heads to restored tails. Scheduled
verification covers the streams of deleted projects as well, so their prefixes
can still be pruned. Events appended after the last verification run are the
undetectable truncation window; the run cadence is part of the audit policy. The
*prune checkpoint*, introduced below, marks the removed prefix. Both live in the
same database and share its limits. Head records and scheduled verification
apply to every stream, the legacy secret chain included; "by age alone" below
refers only to the absence of operation-expired events there.

A project-scoped event caused by an installation operation references that
operation's ID; streams are not interleaved into a single global order. The
streams are pruned independently, so a reference may outlive its target, and
within one stream a later event may reference an operation or grant whose start
was pruned; so on the new streams every cross-stream and parent reference
carries the target's stream identity, sequence and restore lineage in addition
to its operation or approval ID. Legacy events keep their grant and job
identifiers only; their references are resolved through a lookup of those
identifiers against the retained chain and the prune checkpoint's removed range,
outside the event format. An unresolved reference renders as expired only when
the target stream's prune checkpoint covers that sequence; otherwise it is
flagged as unresolved, because a reference to an event that was never written or
was removed out of band is exactly what verification exists to surface. Deletion
must leave enough safe target identification to interpret old events. Use
bounded fields and pagination; repository-controlled strings are untrusted input
and must be safely rendered.

### Local storage and retention

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
as corruption. Grants are not bounded below the window, since pre-existing
native-path grants may be permanent, so the issuance and approval evidence of a
long-lived grant can expire while it is still redeemed; later redemption events
keep the grant identifier but lose the recoverable approver. This loss is
accepted and is named in the disclosure shown at the legacy-prune confirmation.
Retired request-MAC keys are kept until every event signed under them has been
pruned behind a checkpoint, not merely aged past the window, so retained or
hidden rows can still be correlated with later requests. A key that signed a
retained head event on a quiet stream is therefore kept as long as that event,
with the exposure that implies; the retention disclosure names retained keys
alongside retained head payloads. Project deletion does not shorten retention;
today it already leaves secret-audit rows untouched. Policy changes are audited;
shortening the window must explicitly disclose that older history will be
removed. Retention uses server-recorded time, not a caller-supplied timestamp.
On the new streams it must not split an operation that is still active; the
legacy secret chain is pruned by age alone, as stated above. An operation
without a terminal result cannot pin its stream forever: after a bounded,
configurable overrun past the window, reconciliation appends an
*operation-expired* event that closes it as indeterminate, and the prefix
advances; this is a distinct event kind from the write-gap event above. A
terminal result observed after that closure is appended as reconciliation
evidence under the same operation ID and supersedes the expired marker in
rendering; it is never rejected and never invented. If the prefix holding that
operation's start was already pruned, rendering shows the late result against an
expired reference, not as corruption, and the late event does not re-pin
retention for the removed start. The prune boundary stays strictly below the
stream's verified head record: the event the head points to is always retained,
so the presence check of the next verification run can succeed, and a
verification run is required before pruning can advance further. On a quiet
stream that single head event and its payload therefore outlive the window; this
is an accepted exception, named in the retention disclosure. The overrun is part
of the audit policy and is itself audited.

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
required verification/key metadata. Chain verification re-derives hashes over
stored rows and does not recompute request MACs, so a restore without the MAC
keys still verifies every chain. The keys are needed to correlate later requests
with restored records, as ADR 0014 describes. A backup includes them only when
it protects them at least as strongly as the live database does; a plain dump
leaves them out and accepts that correlation across that restore is lost,
because a leaked key enables offline guessing of low-entropy inputs and MAC
forgery. This ADR does not assert that the proposed backup system in [ADR
0025](0025-encrypted-backup-and-installer-recovery.md) is implemented. Document
how an installation's actual backup procedure covers these records. A restore
only contains history through its snapshot: display the snapshot time as the
trail's coverage boundary, record the restore as a new operational lineage that
every later position carries, and never replay recorded actions. Because head
records are restored with the snapshot, events written after it vanish without
detectable truncation; the trail cannot disclose what was lost, only where its
coverage ends. A restore always runs verification on every stream first, whether
or not pruning is enabled, advancing head records to the restored tails. A
stream whose verification fails is marked unverified: its head and pruning stay
frozen, its reads carry that mark and hide rows that are expired under the
snapshot's policy until an administrator resolves the stream, while every other
stream proceeds, so a damaged backup never turns into an audit-wide outage.
Where pruning is enabled, the restore then prunes data expired under the
retention policy contained in the snapshot before ordinary audit reads resume;
before pruning exists, restored data is simply readable. Backup copies and
exported files have independent lifetimes; deleting live rows does not erase
older backups or exports.

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
- An admin-agent read or administrator export is denied when its own audit
  event cannot be written; scope widening beyond the per-turn bound is denied.
- A retention or overrun change, the legacy-prune confirmation and an unverified
  stream resolution are refused when their audit event cannot co-commit; no
  history is deleted during an audit outage.
- An upgrade establishes head records only through a successful verification;
  a pre-existing broken chain is marked unverified and blocks the legacy-prune
  confirmation. A stream resolved with an accepted gap stays verified on the
  next scheduled run.
- An operation without a terminal result is closed as indeterminate after the
  configured overrun, and a later observed result supersedes that marker without
  being rejected or duplicated.
- A verification run fails, and the head record stays put, when the stored head
  is missing or its hash differs; the head never moves backward except through a
  recorded resolution whose event names the old and new sequence, after which
  appends continue past the lost range. The failing stream is marked unverified
  on reads, its pruning freezes, audit health reports it, and only explicit
  administrator resolution clears the mark.
- An upgrade prunes no pre-rollout secret-audit row. Pruning the legacy chain
  starts only after the one-time installation-wide confirmation, whose dialog
  shows the number of events it removes; an installation with no pre-rollout
  secret events applies the default without that gate.
- A prune never removes the event the verified head points to, and it cannot
  advance past the last verification run; the next run's presence check passes
  after every prune.
- A retired request-MAC key is deleted only after every event signed under it
  has been pruned behind a checkpoint; chain verification never depends on it.
- After audit storage recovers from failed best-effort writes, the recovering
  process appends its write-gap event to each affected stream before any other
  event of its own; other processes and streams are unaffected.
- Crash windows and uncertain external outcomes remain indeterminate; retries
  and reconciliation never duplicate the external effect or invent attribution.
- Non-admin users and agents cannot read; current admin agents can read only;
  role revocation and turn identity changes immediately remove that access.
- The Audit logs entry is absent for non-administrators; it shows a status only
  while audit health is degraded or an unverified stream is unresolved, and
  searching for an image ID returns the operation that produced the image.
- Secret-bearing, malformed and oversized inputs never leak through payloads,
  fingerprints, errors or exports; audit data cannot become agent instructions.
- Concurrent append/prune, policy changes and interrupted retention preserve
  verifiable suffixes and accurately declared expired coverage.
- Backups/restores preserve head records and prune checkpoints, preserve
  request-MAC keys only when the backup meets the protection bar and otherwise
  omit them and surface the lost correlation, display the snapshot coverage
  boundary and do not execute historical work. Records
  expired under the restored snapshot's own retention policy are not resurfaced,
  by pruning on verified streams and by hiding on unverified ones; a policy
  change made after the snapshot is itself lost with it.
- Tampering with, removal of, or truncation of events up to the last verified
  head record is detected; the window after that run is documented as
  undetectable. A write-gap event covers best-effort writes that failed on the
  new streams while the process survived; legacy-chain lifecycle losses stay
  unevidenced. No protection is claimed against replacement of all local state
  or against events that were never written.

Runtime schemas, migrations, routes/tools, UI and retention workers require a
separately reviewed implementation. This ADR alone enables none of them.

## References

- [Brokered secrets](0009-brokered-secrets-and-secret-job-executor.md)
- [Approval-gated ACP secret tools](0014-acp-secret-tools-approval-gated.md)
- [Docker policy gateway](0017-docker-policy-gateway.md)
- [Project sandbox sleep and automatic wake](0020-project-sandbox-sleep-and-automatic-wake.md)
- [Multi-user projects and turn identity](0023-multi-user-projects-and-turn-identity.md)
- [Encrypted backup and installer recovery](0025-encrypted-backup-and-installer-recovery.md)
