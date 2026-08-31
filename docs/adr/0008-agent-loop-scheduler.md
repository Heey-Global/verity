# ADR 0008 — Agent Loop Scheduler (recurring, script-first automations)

**Status:** Accepted · **Date:** 2026-07-13

## Naming

The user-facing concept is an **Agent Loop** (plural **Agent Loops**, short
"Loop" in context): a recurring, scheduled activity that runs a script and, when
the script signals it, has an agent act on the result. The internal server timer
that fires due loops is called the **scheduler** — plumbing, never surfaced in
the UI.

> Terminology note: "agent loop" also denotes the *inner* reason-act cycle of a
> single agent run in the wider LLM ecosystem. That inner cycle is untouched
> here; in code we disambiguate by naming everything for the *outer* recurring
> entity — tables `agent_loops` / `agent_loop_runs`, `startAgentLoopScheduler`,
> `registerAgentLoopRoutes`, routes `/agent-loops`. We do not reuse "agent loop"
> for the in-session cycle in comments.

## Context

Verity has projects (repos) and sessions (agent runs in worktrees), plus a
one-off automation seam: a CI failure can auto-dispatch a repair turn
(`packages/server/src/server.ts:1951`, `maybeDispatchCiFailureRepairTurn`). What
it does **not** have is a way to run work **on a recurring schedule** — the
feature described as *"der Loop"*: run a script on a schedule, and when the
script decides it's warranted, let an agent act.

The original Automations surface was a front-end-only "Plan monitor" stub. The
accepted implementation replaces it with persisted Agent Loops, a scheduler,
guided setup sessions, and the operational cockpit described below.

### User model (the shape this ADR commits to)

- A loop is **a script + a schedule**. Nothing else. The *condition* — whether to
  involve an agent — lives **inside the script**, not in Verity. Verity owns no
  threshold/severity DSL.
- A loop owns **one durable agent session in the project**. Each scheduled tick
  runs the script inside that session's container; the script's output lands in
  that session; the agent there is what acts on a finding.
- If that session has been deleted, the next run simply **creates a fresh one**.
- The loop is **created with the help of a setup agent** that authors the script,
  picks the schedule, and proves it works before the loop is armed.

The design goal is a real cron surface: configured loops listed with their
schedule, last run, and last result — grounded in the redesign spec
(`docs/project-screen-redesign.md` §7, §9).

### Constraints carried in from existing decisions

- **Not GitHub-task data.** ADR 0007 constrains anything touching the Projects v2
  board to on-demand-cached GraphQL, never a poll loop. Agent Loops are
  **Verity-local scheduled jobs**; they do not read or write the task board and
  introduce no GraphQL. ADR 0007's rule is untouched.
- **No central job runner.** The repo deliberately avoids poll loops. Each
  recurring concern owns its own self-rescheduling timer and registers an
  `onClose` disposer in `buildServer`. The sandbox auto-update scheduler
  (`server.ts:175`) is the canonical pattern.
- **Durable, idempotent dispatch.** The one existing "finding → agent work" path
  (`maybeDispatchCiFailureRepairTurn`) dedupes durably via the
  `session_automation_marker` table and dispatches through
  `conductor.dispatchTurnWhenIdle`. Agent Loops reuse this machinery.

## Decision

**An Agent Loop is a persisted `{ script, schedule }` bound to one durable agent
session in its project. A single self-rescheduling server timer runs each due
loop's script deterministically inside that session's container; when the script
signals a finding, an idle-only turn is dispatched to that same session's agent.
The loop's logic lives entirely in the script — Verity owns no severity model. A
loop is only armed after a setup agent proves it in a real test run.**

### 1. Persistence — two relational tables

Follow the `projects` table-model pattern (Postgres + Kysely), not the
append-only `events` log.

**`agent_loops`** — the configuration of a scheduled loop.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `project_id` | uuid | FK `projects.id` `onDelete cascade` — loops are project-scoped |
| `name` | text notNull | user-facing label |
| `status` | text notNull default `'draft'` | `'draft' \| 'enabled' \| 'paused'` — only `enabled` loops fire (see §7) |
| `schedule_kind` | text null | `'interval' \| 'daily' \| 'weekly'` (see §3); null while the draft is empty |
| `schedule_config` | jsonb null | structured params for the kind; null while the draft is empty |
| `script` | text null | the loop's script; owns the condition + spawn signal; null while the draft is empty |
| `reaction_prompt` | text null | fallback turn prompt when the script signals without supplying one |
| `reaction_model` | text null | model for the dispatched turn; null → project/server default |
| `session_id` | uuid null | the loop's durable session; FK `sessions.session_id` `onDelete set null`. Set at **creation** (§8), not lazily. Deleting the session doesn't delete the loop — next run recreates one |
| `tested_script_fingerprint` | text null | SHA-256 of the script proven by the last green test; activation requires an exact current match |
| `consecutive_error_count` | int notNull default 0 | circuit breaker counter; five execution errors auto-pause the loop |
| `last_run_at` | timestamptz null | denormalized for the list UI |
| `last_outcome` | text null | denormalized last result: `'ok' \| 'acted' \| 'error' \| 'skipped'` |
| `next_run_at` | timestamptz null | the scheduler's due-time index |
| `created_at` / `updated_at` | timestamptz notNull default now() | |

**`agent_loop_runs`** — run history (append-only per loop).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `loop_id` | uuid | FK `agent_loops.id` `onDelete cascade` |
| `started_at` / `finished_at` | timestamptz | |
| `outcome` | text | `'ok'` (exit 0, no action) · `'acted'` (script signaled → turn dispatched) · `'error'` (crash/timeout/contract violation) · `'skipped'` (couldn't run: sealed store, session busy, project not active) |
| `exit_code` | int null | the script's exit code |
| `detail` | text null | short non-secret outcome/error summary; raw process output is never persisted |
| `session_id` | uuid null | the session this run used |
| `is_test` | boolean notNull default false | true for the creation-time validation run (§7) |

No column holds a credential, so **no encryption** is applied; loop config reads
work while the secret store is sealed (like `getVeritySettingsRaw`).

**A session discriminator.** Loop sessions must render distinctly (pinned last in
the project's session list, a header "edit loop" affordance) and behave
distinctly on delete (§8). Add a `sessions.kind` column
(`'normal' \| 'agent_loop'`, notNull default `'normal'`) rather than resolving it
by a join back through `agent_loops.session_id` — explicit, cheap for the list
UI, and robust if the back-reference is ever null mid-recreate.

Record types, row→record mappers, and `create/get/list/update/delete` +
`recordAgentLoopRun` methods live on `EventStore` alongside the project methods.
The unpublished work lands as one migration, `0038_agent_loops`, which creates
both tables and adds `sessions.kind`.

### 2. Scheduler — one self-rescheduling timer

Model on `startSandboxAutoUpdateScheduler` (`server.ts:175`), adapted from a
fixed 3 AM tick to a **due-time queue** across all loops:

- **Arm** synchronously in `buildServer`; return a disposer wired to
  `app.addHook('onClose', …)`.
- Each pass reads the **minimum `next_run_at`** across `enabled` loops, sleeps
  until then via `setTimeout(...).unref()`, then runs every loop whose
  `next_run_at` is due.
- A due tick is claimed with one conditional database update (`enabled` and still
  due). Only the winner advances `next_run_at` and executes, preventing duplicate
  runs across concurrent server processes and respecting a racing pause.
- **Overlap guard**: a `running` flag; a slow pass never overlaps the next tick.
- **Per-loop `try/catch`** records an `agent_loop_runs` row with `outcome:'error'`
  and continues; an outer `try/catch` keeps one bad pass from killing the
  schedule.
- During that claim, compute and persist the next `next_run_at` from the schedule,
  so restarts resume correctly (the timer is stateless; the DB is the source of
  truth).
- **Sealed-store aware**: config reads are non-decrypting; if a run needs
  decrypted credentials and the store is sealed, the run is recorded as `skipped`
  and retried next tick (never a hard failure).

### 3. Schedule representation — structured, not raw cron

Raw cron strings are hostile on a mobile UI. Store a discriminated
`schedule_kind` + `schedule_config` JSON:

- `interval` — `{ everyMinutes: number }` (floor guarded, ≥ 15; see §7).
- `daily` — `{ hour: number, minute: number }` (server-local, matching the
  sandbox updater's hour model).
- `weekly` — `{ weekday: 0-6, hour, minute }`.

A pure `computeNextRun(schedule, from)` helper lives next to the store logic and
is unit-tested without a DB or timers. Cron expressions can be added as a fourth
kind later without a schema change.

### 4. Execution — one durable session per loop, script-first

Each due tick, for one loop:

1. **Ensure the session.** Normally the loop already has its session (created with
   the loop, §8). Only if `session_id` is null or the referenced session no longer
   exists (the user deleted just the session) → allocate a project worktree (the
   `POST /sessions` recipe: `deps.projectWorktrees.add`, refresh git token,
   `eventStore.createSession` with `kind:'agent_loop'`), and store its id on the
   loop. This step requires the project to be `active`; if it isn't, record
   `skipped` and move on.
2. **Run the script deterministically** inside that session's container, with a
   in-container hard timeout (§7), capturing the exit code without persisting raw
   stdout/stderr. This spends **no model
   tokens**. The run and its output are recorded into the loop's session so the
   user sees the loop's activity in one place.
3. **Classify by the script's own signal:**
   - exit `0` → `outcome:'ok'`, nothing dispatched.
   - exit `10`, or stdout carrying `{"spawn": true, "prompt"?, "model"?}` →
     `outcome:'acted'`: dispatch an **idle-only turn** into the loop's session
     (`conductor.dispatchTurnWhenIdle`) with the script-supplied prompt, else the
     loop's `reaction_prompt`. The script owns the prompt when it wants dynamic
     context from what it found.
   - every other non-zero exit, timeout, crash, or contract violation →
     `outcome:'error'`, nothing dispatched.
4. **Record** the `agent_loop_runs` row and update the loop's `last_run_at`,
   `last_outcome`, and `next_run_at`.

There is no separate "spawn a new session" path and no Verity-side severity model:
the loop has exactly one session, recreated only when it has been deleted, and the
script is the sole authority on whether the agent acts.

### 5. Reaction dispatch — idle-only + marker-deduped

The turn dispatch reuses the existing durable-idempotency machinery:

- **Idle-only:** `conductor.dispatchTurnWhenIdle` — if a turn is already running
  in the loop's session, the new one is not stacked. A flapping script can never
  pile up turns.
- **Deduped:** a `session_automation_marker` of `agent-loop:<loopId>:<runId>`
  (matching `maybeDispatchCiFailureRepairTurn`): mark before dispatch, roll the
  marker back if dispatch isn't accepted so a transient failure can retry, never
  double-fire.

### 6. Routes & client

`registerAgentLoopRoutes(app, deps)` (extracted registrar, modelled on
`registerOnboardingRoutes`):

- `POST /projects/:id/agent-loops` — creates the `draft` loop **and** its bound
  `kind:'agent_loop'` session and seeds the setup-agent turn (§8); returns the loop
  + its `session_id`.
- `GET /projects/:id/agent-loops` — list for the project.
- `GET/PATCH/DELETE /agent-loops/:loopId` — read; `PATCH` is the confirmation
  widget's persistence target (§8); `DELETE` is the "session and loop" branch.
- `POST /agent-loops/:loopId/session` — recreates and links the durable session
  after the user chose "session only" deletion, then returns the updated loop.
- `POST /agent-loops/:loopId/test` — the validation run (§7A); its result gates
  `Enable`.
- `POST /agent-loops/:loopId/run` — an explicit production run from the Loop
  cockpit. It uses the same executor, single-flight lock, history, and circuit
  breaker as a scheduled tick; only the schedule advancement is omitted.
- `GET /agent-loops/:loopId/runs` — run history.

Zod schemas for params/body, `503 notConfigured` when the scheduler dep is absent,
union return types. The mobile client (`packages/mobile/src/api.ts`) gains
`agentLoopSchema`/`AgentLoopPatch` and `list/create/update/deleteAgentLoop` +
`testAgentLoop` + `listAgentLoopRuns` methods, following the existing
project-method shapes.

## 7. Creation guidelines & runtime guardrails

The whole point: constrain **creation** tightly enough that **execution** is
stable. Three layers.

### A. Creation-time — a loop is armed only after it passes a real test run

- A loop is created as `status:'draft'` and **never fires while `draft`**.
- The **setup agent** authors the script + schedule and must run
  `POST /agent-loops/:id/test` — a real execution in the project container
  (`is_test:true`) — before proposing to enable it.
- The user can move a loop to `enabled` **only** after a test run that:
  terminated cleanly within the timeout, honoured the exit/stdout contract, and
  produced bounded output. "It ran once at creation" is the precondition for
  arming. An untested loop is never scheduled.

### B. Script contract — makes each run predictable

- **Bounded runtime.** A hard per-run timeout (default 120 s) runs inside the
  container so killing the local Docker client cannot leave the script alive.
  Overrun → the run is `error` and nothing is dispatched. The setup agent must
  keep the script well under it.
- **Exit / stdout contract.** `exit 0` = do nothing; `exit 10` or a single
  `{"spawn":true, "prompt"?, "model"?}` JSON line on stdout = act. Every other
  non-zero exit is an execution error.
- **No raw-output persistence.** stdout/stderr are bounded in memory for contract
  parsing but are never written to run history or the transcript. Only an explicit
  JSON `prompt` may cross into an agent turn. Verity-managed credentials are
  blanked from the loop process environment.
- **Read-only by default.** The script *checks*; it does not commit, push, or
  mutate the repo — those are the agent's job on the dispatched turn. The setup
  agent must enforce this when authoring.
- **Self-contained.** The script may only rely on tooling the project devcontainer
  guarantees; the setup agent verifies every command it calls during the test run.

### C. Runtime stability — no runaway

- **No stacking.** Idle-only dispatch (§5): a run never starts a second turn while
  the loop's session is busy.
- **Dedupe.** One finding → at most one turn (marker, §5).
- **Schedule floor.** `interval.everyMinutes ≥ 15`, and the per-run timeout must be
  strictly less than the interval so runs can never overtake each other.
- **Fail-safe.** A script crash/timeout is an `error` outcome, never a spawn loop.
- **Circuit breaker.** Five consecutive scheduled execution errors automatically
  move the loop to `paused`; a successful scheduled run resets the counter. Test
  runs neither trip nor reset this breaker.

These two layers of "authored under guardrails" map to two concrete artifacts: the
**setup-agent prompt** (what it must produce and prove in the test run) and the
**scheduler invariants** (timeout, idle-only dispatch, dedupe, draft-until-tested).

## 8. Creation, editing & deletion UX — the loop *is* its session

A loop is not configured through a form; it is configured **in a chat with a
setup agent**, and that chat's session *is* the loop's durable runtime session.
Setup agent and runtime agent are one and the same session — this is why
`session_id` is set at creation (§1/§4).

**Creating.** In a project, `+` offers **Session** or **Agent Loop**. Choosing
Agent Loop:

1. Creates the `agent_loops` row (`status:'draft'`, no script/schedule yet) **and**
   its bound session (`kind:'agent_loop'`) in a project worktree, and seeds the
   session's first turn with the **setup-agent prompt**.
2. The agent walks the user through *what to check*, *the schedule*, and *the
   script* via question-and-answer in the chat.
3. **Config is committed via a confirmation widget (not an agent tool).** The agent
   *proposes* the concrete `{ script, schedule, reactionPrompt?, reactionModel? }`
   in a `verity:agent-loop` fenced JSON contract. Runtime adapters lift the block
   into the canonical `agent_loop_proposal` event; the mobile reducer renders that
   event as a structured, reviewable transcript widget. The user taps
   **Confirm**; the app then `PATCH`es `/agent-loops/:loopId` and runs
   `POST /agent-loops/:loopId/test`. Only a **green test run** unlocks **Enable**,
   which flips `status → 'enabled'`. The human tap before arming is the deliberate
   gate that satisfies draft-until-tested (§7A); the agent never writes persistence
   or arms a loop on its own.

**Distinct in the list.** A `kind:'agent_loop'` session renders differently and is
**pinned last** in the project's session list, so the loop's home is always
findable and never mistaken for an ordinary session.

**Operating and editing.** The loop session carries a fixed **Loop cockpit**
affordance. The cockpit is the single operational home for status, schedule,
next/last run, consecutive failures, **Run now**, pause/resume, edit, and run
history (including test-vs-production, duration, outcome, exit code, and bounded
detail). Edit dispatches a *reconfigure* turn to the same session's agent, which
walks the user through changes and again ends in a **confirm → PATCH → re-test**
cycle. Any executable-config change (script, schedule, reaction prompt, or model)
invalidates the attestation, returns the loop to `draft`, and requires a new green
test before it can run or re-arm.

**Deleting — ask what to delete.** Deleting a loop session prompts a choice, since
the two objects have different lifetimes:

- **Session only** → delete the session; the `agent_loops` row survives
  (`session_id` → null via `ON DELETE SET NULL`). The loop keeps firing; the next
  run recreates a fresh `kind:'agent_loop'` session. Only the setup chat history is
  lost, never the config.
- **Session and loop** → `DELETE /agent-loops/:loopId` cascades away the loop and
  its `agent_loop_runs`, then the session is removed. The automation is gone for
  good.

## Consequences

**Positive:** a genuine recurring-automation backend that turns the honest stub
into a working cron surface; one small, well-understood timer following an
established in-repo pattern; the loop's logic lives in a plain script the user
(via the setup agent) fully controls — no Verity-side severity DSL to design or
maintain; one durable session per loop gives the agent continuity across runs and
one place to watch; draft-until-tested keeps unproven loops from ever firing; no
new GraphQL and no impact on ADR 0007.

**Negative / accepted:** Agent Loops are Verity-local — the first persisted
scheduled entity, so a small amount of net-new store/scheduler surface. Running
the script needs the project container up (an `active` project); when it isn't,
the run is `skipped`, not retried aggressively. Schedule resolution is
server-local time (no per-user timezone in v1). The name "Agent Loop" is
chosen deliberately despite overlapping with the inner reason-act cycle; the
disambiguation lives in code naming (see Naming).

**Guardrails that must hold:** the scheduler stays a single self-rescheduling
`unref`'d timer with an overlap guard and an `onClose` disposer — never a tight
poll loop; reaction dispatch stays idle-only + marker-deduped; a loop never fires
while `draft`; Agent Loops never touch the GitHub task board (ADR 0007).

## Configuration / gating

The scheduler is built only when its dependencies (a conductor + project
worktrees + provisioner) are present, mirroring how the sandbox updater no-ops
when its deps are absent. With no `enabled` loops, the timer idles. The
`/agent-loops` routes `503` when the loop service is not wired, matching the
`/tasks` gating pattern.

## Suggested build order

1. **Store foundation** — `agent_loops` + `agent_loop_runs` tables and the
   `sessions.kind` column (`0038`); `EventStore` CRUD + `recordAgentLoopRun`,
   `computeNextRun` helper. Unit-tested.
2. **Execution core** — a `runAgentLoop(loop)` unit: ensure/recreate session, exec
   script with an in-container timeout and non-persisted bounded output, classify
   by exit/stdout, idle-only +
   marker-deduped turn dispatch. Tested with a fake conductor + a stub container
   exec.
3. **Scheduler** — `startAgentLoopScheduler(deps)` on the sandbox-updater pattern;
   due-time queue over `enabled` loops; `onClose` disposer. Tested with a fake
   clock.
4. **Routes + client** — `registerAgentLoopRoutes` (create-loop-and-session, PATCH,
   `/test`, `/run`, runs); mobile API methods + schemas.
5. **UI** — `+` → Session | Agent Loop; the in-session setup-agent chat + the
   confirm-config widget (§8); the `kind:'agent_loop'` session pinned last with an
   Loop cockpit; the delete-choice prompt (session vs. session+loop); the
   Automations list showing schedule / last run / last result; retire the
   preview-only framing.

## Related

- `docs/project-screen-redesign.md` §7 (Automations, first-class) and §9 (server
  follow-up: "loop schema, persistence, a scheduler, run history, and the
  'finding starts a session' hook").
- `packages/server/src/server.ts:175` — `startSandboxAutoUpdateScheduler`, the
  scheduler pattern this ADR builds from.
- `packages/server/src/server.ts:1951` — `maybeDispatchCiFailureRepairTurn`, the
  idle-only, marker-deduped dispatch pattern.
- ADR 0007 — task management (GraphQL board). Agent Loops are explicitly **not**
  task data and add no GraphQL.
