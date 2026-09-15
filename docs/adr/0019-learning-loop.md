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

### D3 — The read path is a server-computed digest of aggregates, not a transcript feed

A new internal broker route returns the digest:

```
POST /internal/realm/learning-digest   { windowHours, minOccurrences }
   → { candidates: [ { key, count, projectCount, firstSeen, lastSeen, exemplars[] } ] }
```

It follows the memory broker's internal-listener placement, but deliberately does **not** use
the per-container capability as sufficient authority: ordinary sessions in that container
share it. When the executor starts a claimed Learning Loop run, the server mints a short-lived,
single-use digest grant bound to `{ loopId, runId, sessionId, realmId }` and provides it only to
that script invocation. The route consumes the grant and verifies the persisted loop kind,
run and session before resolving the realm. The Sandbox supplies no realm or project id. A
normal session, another loop, a replay, and a loop whose host was moved all fail closed.

The script fetches the digest once and emits it through the existing Agent Loop stdout
contract; the reaction turn receives that external-data block and never receives the grant.

The route returns **counts keyed on structural fields** — tool name, risk class, denial
reason, error kind — with at most a handful of exemplars per candidate, each passed through
`redactSessionObservationText`. It does not return transcripts.

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

**Admissible signals:** `permission` events and `result.permissionDenials` (what the operator
blocked, and what the runtime auto-denied), `secret_approvals` decisions, and user prompts in
the `messages` projection (`role:'user'`).

**Inadmissible:** `tool_result` output, agent-authored text, repository content, and anything
fetched from a document or a knowledge namespace. The digest query selects the admissible
signals; the inadmissible ones are not in its `FROM` clause, which is a stronger guarantee
than instructing the model to ignore them.

The digest crosses into the reaction turn through `appendExternalPromptData` with source
`verity:learning-digest` — the seam the Agent Loop executor already uses. Two honest limits
belong on the record: a user prompt can itself contain text the operator pasted from an
untrusted source, and `external-content.ts` says of itself that it "is a prompt-structure
boundary, not a prompt-injection classifier … it cannot make an untrusted document
trustworthy". Provenance bounds authority; it does not confer trust.

**One gap to close or accept:** an ordinary permission allow/deny is not persisted as a
decision row (see Context). The strongest available signal is therefore "the operator was
asked, and the turn reports the tool was denied", not "the operator denied it at 02:14".
Phase 1 derives from what exists. A durable decision row would make the provenance rule
sharper and is the first follow-up worth doing.

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

This is consistent with ADR 0018 D5's restriction that only the operator writes realm
memory, and the ADR should not leave that to be rediscovered: the **tap is the operator
write**. The agent proposes text and the operator commits it, exactly as it proposes a loop
script today without being able to arm it. No path in this design lets an unattended turn
write at realm altitude.

Nothing the loop produces changes behaviour without a tap. There is no auto-enforce mode and
no operator-veto mode — a guardrail must not be live while it is being judged.

### D7 — What a Learning Loop must never do

- **No repository writes.** It proposes text; it does not commit, push, or open a pull
  request. This is ADR 0008 §7B's read-only script rule, and it applies to the reaction turn
  here as well.
- **No use of the session-observation tools.** They are approval-gated per call and
  explicitly non-pollable. The loop uses the digest route or nothing.
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

- New surface: one internal route plus its digest query and single-use execution grant, one
  fenced proposal contract and canonical event, the server-side hold-out evaluation, and a
  per-realm loop configuration. No new scheduler, session kind, or standing credential.
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

- Which structural keys the digest aggregates on. Tool name plus denial reason is the obvious
  first set; whether error kind and risk class add signal is an empirical question for the
  first window of real data.
- Hold-out window size and the pass criterion for D5 — the numbers matter more than the
  mechanism and should come from measurement, not from this document.
- Whether to add a durable permission-decision row (D4). Recommended, as a separate change.
- How the UI chooses a host project and guides rehosting when no project in a realm is an
  obvious long-lived host.
- Whether proposals should ever target a repository's `AGENTS.md` rather than memory. That is
  a pull request, not a memory write, and belongs in its own ADR if it is wanted.
- How a guardrail is retired. Memory is operator-curated and prunable, but nothing currently
  tells the operator that a guardrail approved four months ago has stopped matching anything.
