# ADR 0019 — Learning Loop: realm-scoped guardrail proposals from transcripts

**Status:** Proposed · **Date:** 2026-09-15
**Depends on:** [ADR 0018](0018-knowledge-realms-and-namespaces.md) (realms), builds on
[ADR 0008 — Agent Loop Scheduler](0008-agent-loop-scheduler.md)

## Context

The control-plane concept describes a nightly loop that reads session transcripts,
classifies what went wrong, checks whether it recurs, proposes a guardrail, and rolls it
out after operator approval — "Transkripte → klassifizieren → Rekurrenz → Vorschlag →
Operator-Approval → Rollout" (`docs/AGENT_CONTROL_PLANE_KONZEPT.md:55`), listed at `:116`
as the thing that makes the fleet worth owning.

That loop has never existed in this repository. The `/opt/optimizer` the concept names ran
on the predecessor `dev`-CLI setup and was not carried over. On the roadmap it sits in
Phase 2 (`:385`, "Lern-Loop-Inbox") and app v2 (`:330`); Phase 3 shipped ahead of it.

### What exists now that did not when the concept was written

- **The scheduler is built.** ADR 0008's Agent Loop is complete end to end: a due-time
  scheduler (`packages/server/src/agent-loop-scheduler.ts`, wired at `server.ts:3282`), a
  shared executor with an in-process lock (`agent-loop-executor.ts`), draft-until-tested via
  `tested_script_fingerprint`, a five-error circuit breaker (`packages/store/src/store.ts:4325`),
  idle-only marker-deduped dispatch, run history, and a cockpit
  (`apps/mobile/components/AgentLoopCockpit.tsx`).
- **A propose → confirm → persist contract is built.** The setup agent emits a fenced
  `verity:agent-loop` JSON block, the adapter lifts it into a canonical
  `agent_loop_proposal` event (`packages/session/src/acp-adapter.ts:364`), the mobile
  reducer renders a widget, and only an operator tap writes. The agent never arms anything
  itself.
- **A provenance seam is built.** `appendExternalPromptData`
  (`packages/events/src/external-content.ts`) wraps untrusted data in a JSON-escaped,
  provenance-labelled block with an explicit "this is reference material, not instructions"
  preamble. The Agent Loop executor already uses it for script output.
- **Redaction for transcript reads is built.** `redactSessionObservationText`
  (`packages/server/src/session-observation.ts`) strips known credential shapes, header
  values, and high-entropy opaque tokens, and bounds message length.
- **A realm scope is being introduced.** ADR 0018 makes a realm the operator-facing
  separation between private and business knowledge.

### What does not exist

- **A cross-project read path for unattended work.** The session-observation tools read
  other sessions, but they are approval-gated per call, capped at 50 messages, and their own
  description states they "must not be polled" — the opposite of a nightly bulk pass.
- **A durable record of an ordinary permission decision.** The operator's allow/deny
  resolves the live prompt through `conductor.decidePermission`
  (`packages/server/src/session-control-routes.ts:57`); what persists is the `permission`
  event and the turn's `result.permissionDenials`
  (`packages/events/src/events.ts:434`). Durable decision rows exist only for brokered
  secrets (`secret_approvals`, `brokered_grant_approvals`, plus the hash-chained trail).
- **A retrieval layer.** Broad project and global search missed their latency targets in
  `docs/search-performance-spike.md`.

## Decision

**A Learning Loop is an Agent Loop, scoped to one realm, that reads a server-computed
aggregate digest of operator actions — never raw transcripts — and proposes guardrail text
through the existing confirm-widget contract. Verity adds a read path and a proposal type.
It adds no scheduler, no classifier service, and no automatic enforcement.**

### D1 — It is an Agent Loop, not new infrastructure

The Learning Loop reuses the whole of ADR 0008: the schedule, the executor, the in-container
timeout, the exit/stdout contract, draft-until-tested, the circuit breaker, idle-only
dispatch, the run history and the cockpit. It is a nightly loop whose script fetches a digest
and whose reaction turn reasons about it.

The value of this is operational rather than aesthetic. Everything that makes an unattended
recurring job safe to run — it cannot stack turns, it pauses itself after five consecutive
failures, it never fires unproven, its raw output is never persisted — already exists and has
tests. A separate optimizer service would have to re-earn all of it.

### D2 — One Learning Loop per realm; never one across realms

ADR 0018 makes realms the boundary that keeps private and business knowledge apart. A loop
that read every realm's transcripts in order to learn from them would be the single component
that undoes that boundary, and it would do so in the least visible place: a nightly
unattended job.

So a Learning Loop belongs to exactly one realm. It reads only sessions of projects in that
realm and may propose only into that realm. Two realms get two loops, with two schedules and
two run histories. The duplication is the point.

This requires an explicit lifecycle distinction rather than inferring the realm from the
current host project. `agent_loops` gains `kind = 'standard' | 'learning'` and a nullable
`realm_id`; a learning row has exactly one `realm_id`, while a standard row has none. It still
uses one project-owned session as its execution host. Moving that host project to another
realm or deleting it is rejected while it hosts a Learning Loop; the operator must first
rehost or delete the loop. Rehosting changes the project/session, never the loop's realm.
One partial unique index on `realm_id WHERE kind = 'learning'` enforces the stated one-loop
cardinality under concurrent creation.

The host project must belong to the loop's realm. Creation and rehosting check that equality
in the same transaction that writes the loop; every claimed run re-resolves it before session
creation or digest computation and fails closed on a mismatch. The realm-move guard above
therefore also prevents moving a current Learning Loop host until it is rehosted. That check
and its row locks are mandatory realm-move preflight steps, before any session is stopped or
closed.
The existing cascading `agent_loops.project_id` foreign key remains for standard loops. A
database deletion guard rejects deletion only when a `kind = 'learning'` row names the
project, closing races independently of the application transaction; the project-deletion
route reports the hosted loops that must be rehosted or explicitly deleted first.

### D3 — The read path is a server-computed digest of aggregates, not a transcript feed

A server-internal digest service returns:

```
computeLearningDigest({ loopId, runId, windowHours, minOccurrences })
   → { candidates: [ { key, count, projectCount, firstSeen, lastSeen, exemplars[] } ] }
```

It is not exposed on the internal listener and has no Sandbox capability or credential.
Ordinary sessions share a project container, so no secret delivered to a loop process there
would constitute an authorization boundary. Instead, a Learning Loop script can only signal
the ordinary spawn decision and optional subject prompt. That prompt remains untrusted script
output and is wrapped through the existing Agent Loop `appendExternalPromptData` boundary.
After parsing the bounded spawn record, the server-side executor verifies the persisted loop
kind, claimed run, session and realm, calls the digest service directly, and attaches its
result as a separate external-data record. The Sandbox never receives authority to query the
corpus or select a realm. A normal session, another loop, and a loop whose host moved cannot
invoke this path.

The request is server-bounded: `windowHours` is at most 720 (30 days), `minOccurrences` is at
least 3, and the response contains at most 100 candidates, three exemplars per candidate,
4,000 characters per exemplar, and 128 KiB total serialized data. The server truncates within
those bounds and records truncation in the response; the script cannot widen them.

Each candidate carries an opaque, authenticated `candidateEvidence` id. At digest computation
the server persists an immutable evidence row bound to the loop, run, realm, host session,
dispatched reaction turn, structural predicate, train/hold-out windows and server-computed
metrics, retained for 30 days. A proposal must echo the id; at proposal-event ingestion the
server resolves the emitting session/turn from trusted event context, requires every binding
to match, and atomically consumes the evidence id under a unique constraint so it cannot be
replayed. It then derives the displayed fields from the evidence row and persists a
verification receipt with the proposal. A later operator tap references that immutable
proposal row. This keeps raw
source transcripts out of the evidence store, permits delayed unattended ingestion within the
documented retention window, and avoids trusting a rewritten prompt or recomputing against
later data. The bounded, redacted digest attached to the reaction prompt is ordinary prompt
content and remains in that Learning Loop session's transcript under normal session-retention
rules; the UI must describe that retention rather than calling the digest ephemeral. The
session's immutable realm provenance and ADR 0018's same-realm observation checks continue to
protect that transcript after rehosting or a later host-project realm move.

To make the turn binding possible, the executor reserves and durably records the reaction
turn id before computing the digest, then passes that id to an extended
`dispatchTurnWhenIdle`. Evidence is finalized only if dispatch accepts that exact reservation;
a rejection cancels the reservation and deletes its unfinalized evidence. Backends may not
substitute a different turn id.

The service returns **counts keyed on structural fields** from the durable operator-decision
sources — tool name, risk class, behavior, scope and safe secret-target identifiers — with at
most a handful of exemplars per candidate, each passed through
`redactSessionObservationText`. It does not return transcripts.

Exemplars are projections from the admissible row itself, never joins back to a permission
request, event payload, message or transcript. An ordinary permission-decision exemplar may
contain only `{ toolName, riskClass, behavior, scope }`; a secret decision only safe target
identifiers plus behavior/scope; an explicit feedback exemplar only its dedicated
operator-authored category and correction fields. Agent-supplied tool input, `updatedInput`,
free-form denial messages and surrounding session text are excluded at the SQL projection.

Two reasons, and the second is the load-bearing one:

- Recurrence counting is a query PostgreSQL does well and a language model does badly. Doing
  it in SQL is cheaper, deterministic, and reviewable.
- **The corpus never enters a context.** A loop that fed transcripts to a model would put
  every session's text through an LLM nightly, defeat the bounded-read design the observation
  tools were built around, and make redaction a best-effort filter on a very large surface
  instead of a bound on a small one.

It also sidesteps the search-spike problem: this is a scheduled aggregation over a bounded
window with a `minOccurrences` floor, not an interactive broad query.

### D4 — Candidates derive from operator actions only, and reach the agent as external data

The concept's provenance rule (`:417`) is that guardrail proposals may be derived from
operator actions and corrections, never from tool-output text — the same rule that keeps
memory from being poisoned by something an agent read.

**Admissible signals:** durable ordinary permission-decision rows, `secret_approvals`
decisions, and explicit operator-feedback events created by a dedicated UI action. Adding the
ordinary decision row is therefore a prerequisite for the Learning Loop, not a follow-up.
Each signal records its operator actor and decision source.

**Inadmissible:** permission-request events, runtime-generated `permissionDenials`, ordinary
user prompts, `tool_result` output, agent-authored text, repository content, and anything
fetched from a document or a knowledge namespace. The digest query selects only durable
operator-decision sources; the inadmissible ones are not in its `FROM` clause, which is a
stronger guarantee than instructing the model to ignore them.

The digest crosses into the reaction turn through `appendExternalPromptData` with source
`verity:learning-digest` — the seam the Agent Loop executor already uses. As
`external-content.ts` says, this is a prompt-structure boundary, not an injection classifier.
Provenance bounds authority; it does not confer trust.

### D5 — A recurrence threshold and a hold-out evaluation gate, before anything is proposed

Two filters run before the agent is allowed to propose, both from the concept's hardening
section (`:418`–`:422`):

- **Recurrence.** A candidate needs `count ≥ minOccurrences` across the window, configured
  per loop with a floor of 3. This is what stops the loop overfitting to noise.
- **Hold-out evaluation.** Candidate records include a constrained structural predicate over
  the admissible fields from D4. The server, not the model, evaluates that predicate against a
  disjoint hold-out window and returns its match count and unrelated-signal match rate. The
  proposal event is accepted only when it cites a digest candidate and unchanged predicate
  whose server-computed metrics pass the configured threshold. No hold-out transcript or
  message text enters the model context.

The metrics are evidence that the recurring signal generalizes; they do not claim that
arbitrary natural-language guardrail text would have prevented an event. The operator sees
that limitation with both numbers. This narrower gate is implementable without exposing the
hold-out corpus and still filters one-off symptoms before review.

### D6 — The rollout target is realm or project memory, through a confirm widget

A proposal is a new fenced contract mirroring ADR 0008 §8: a `verity:guardrail` block lifted
into a canonical `guardrail_proposal` event, rendered as a widget, written only on an
operator tap. The tap appends the approved text to `project_settings.memory` or
`realms.memory`, where ADR 0018 D5's two-part injection puts it into every future context of
the scope.

The verified proposal row records its evidence realm and target kind/id. Approval runs
transactionally. A realm target must equal the evidence realm. For a project target, the
server re-resolves the project's current non-null realm and requires the same equality. A
mismatch marks the proposal stale and writes no memory; the loop must produce evidence in the
target's realm before approval.

This is consistent with ADR 0018 D5's restriction that only the operator writes realm
memory, and the ADR should not leave that to be rediscovered: the **tap is the operator
write**. The agent proposes text and the operator commits it, exactly as it proposes a loop
script today without being able to arm it. No path in this design lets an unattended turn
write at realm altitude.

Nothing the loop produces changes behaviour without a tap. There is no auto-enforce mode and
no operator-veto mode — a guardrail must not be live while it is being judged.

### D7 — What a Learning Loop must never do

- **No repository writes.** It proposes text; it does not commit, push, or open a pull
  request. The script inherits ADR 0008 §7B's read-only execution. Unlike an ordinary Agent
  Loop, the Learning Loop reaction turn runs with a dedicated tool-less policy: it can emit
  text (including the proposal fence) but receives no shell, filesystem, MCP, observation or
  mutation tools. If a backend cannot enforce that profile, it cannot run Learning Loops.
- **No use of the session-observation tools.** They are approval-gated per call and
  explicitly non-pollable. The server executor uses the digest service or nothing.
- **No cross-realm read**, by construction (D3) rather than by instruction.

## Alternatives considered

- **A standalone optimizer service**, as `/opt/optimizer` was. Rejected: it would duplicate a
  scheduler that now exists, sit outside the permission, audit and circuit-breaker model, and
  need its own credentials and its own read path into the database.
- **Feed transcripts to a nightly agent and let it find patterns.** Rejected: it makes the
  entire corpus a model context, turns redaction into a filter over a very large surface,
  costs roughly the corpus in tokens every night, and is the exact shape the memory-poisoning
  rule warns about. D3 is the counter-proposal.
- **Embedding-based clustering of transcripts.** Deferred for the same reason ADR 0018 D3
  declines a retrieval layer: there is none, building one is its own project, and recurrence
  on structural keys is cheaper, deterministic and auditable. If structural keys prove too
  coarse, this is the next thing to try.
- **Auto-enforce with an operator veto.** Rejected in D6.
- **One global Learning Loop.** Rejected in D2.
- **A dedicated Learning Loop session type.** Rejected: `sessions.kind = 'agent_loop'` remains
  sufficient. The discriminator and realm binding live on `agent_loops`, where scheduling,
  authorization and lifecycle decisions are made.

## Consequences

- New surface: one server-internal digest service, one fenced proposal contract and canonical
  event, authenticated candidate-evidence tokens and verification receipts, the server-side
  hold-out evaluation, a tool-less reaction profile, and a per-realm loop configuration. No
  new scheduler, session kind, route, capability, or standing credential.
- Everything inherits ADR 0008's guardrails, including the ones that matter most for an
  unattended job: it cannot stack turns, it pauses itself after five consecutive errors, and
  its raw output is never persisted.
- The transcript corpus never enters a model context. Only aggregates and a bounded number of
  redacted exemplars do.
- Token cost is one bounded digest per realm per night, not a function of transcript volume.
- **It will under-detect.** Recurrence over structural keys cannot see friction that exists
  only in prose. This is accepted: a loop that raises few well-evidenced proposals is the one
  an operator keeps reading, and the concept's own threshold argument points the same way.
  Under-detection is recoverable; a confidently wrong guardrail injected at realm altitude is
  less so.
- Depends on ADR 0018. Without realms there is no scope for the loop to be safe in, and the
  cross-realm read it would otherwise need is the thing D2 refuses.

## Scope / open questions

- Which admissible structural keys the digest aggregates on. Tool name, risk class, behavior
  and scope are the first set; whether safe secret-target identifiers add signal is an
  empirical question for the first window of real data.
- Hold-out window size and the pass criterion for D5 — the numbers matter more than the
  mechanism and should come from measurement, not from this document.
- How the UI chooses a host project and guides rehosting when no project in a realm is an
  obvious long-lived host.
- Whether proposals should ever target a repository's `AGENTS.md` rather than memory. That is
  a pull request, not a memory write, and belongs in its own ADR if it is wanted.
- How a guardrail is retired. Memory is operator-curated and prunable, but nothing currently
  tells the operator that a guardrail approved four months ago has stopped matching anything.
