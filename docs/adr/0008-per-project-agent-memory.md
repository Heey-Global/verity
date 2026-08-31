# ADR 0008 — Per-Project Agent Memory

**Status:** Proposed · **Date:** 2026-07-13

## Context

Operators want to tell an agent "remember this" / "merk dir das" and have that note
**persist across sessions** for the same project — including brand-new sessions on any
backend and in any container. Today there is no place for this to live:

- **Session worktrees are ephemeral.** Each session runs in its own fresh git worktree
  (`.verity-sessions/agent-<id>`); Verity removes it after merge
  (`packages/server/src/worktree.ts`). A file the agent writes there but does not commit
  is gone with the worktree, and a committed file only reaches the next session **after
  its PR merges**.
- **The Claude config dir is per-sandbox and ephemeral.** Claude's own memory directory
  (`~/.claude/.../memory`) does not survive across sessions, because the config dir is
  isolated per sandbox and not persisted.
- **`agent-seed` is read-only.** The cross-container toolkit mounted at `/opt/agent-seed`
  (`packages/server/src/provisioner.ts:1841`) is read-only, so the agent cannot write
  memory there.
- **The only persistent Verity-side state is the store DB.** Per-project config lives in
  `project_settings` (`packages/store/src/schema.ts:99`), keyed by `project_id`, and is
  surfaced/edited from the operator UI. It has no memory field.

The operator also wants this memory **visible and editable in the Project Settings** —
they curate what the agent has remembered — and confirmed that concurrent operator/agent
edits are **not** a concern (a single operator, never editing the same project's memory
in two places at once).

The mechanism must be **runtime-neutral** (Claude, Codex, OpenCode), so its core guidance
cannot rely on project-specific instruction files or a Claude-specific feature such as
the `@AGENTS.md` import.

## Decision

**Add a per-project free-text "agent memory" stored in `project_settings`. The agent
appends to it through a new capability-authenticated internal broker endpoint via a
`verity-memory` seed binary; the operator reads and edits it in the Project Settings UI;
the server injects it into every new session's system prompt at spawn.**

Memory is a **single free-text blob per project**, not structured entries. The operator
explicitly de-scoped concurrent-write handling, so we avoid the complexity of per-entry
rows, sources, and timestamps. Agent writes are append-only read-modify-write; operator
edits replace the whole text.

### Storage

Add one nullable column to the existing per-project settings table rather than a new
table — it inherits the `project_id` keying, the operator UI plumbing, and the
`updateProjectSettings` upsert (`packages/store/src/store.ts:1633`):

```
project_settings.memory  TEXT NULL   -- plaintext; not a secret
```

Not encrypted (it is operator-visible content, unlike `doppler_token`). The column is
added through a new keyed migration in `packages/store/src/migrations.ts` (following the
existing `NNNN_project_settings`-style `alterTable().addColumn()` entries); existing rows
backfill as `NULL`.

A soft size cap (e.g. a few KB) is enforced **in the shared store layer**
(`updateProjectSettings`), not only in the broker handler — otherwise the operator UI
write path (below) could persist an arbitrarily large blob that then bloats the injected
prompt. Both write paths go through the same upsert, so enforcing there covers both.

### Write path A — the agent (broker)

Reuse the `gh-token` broker **transport and identity model** (the security implications
of that reuse are discussed under "Security" below):

1. New seed binary `agent-seed/bin/verity-memory` with `append "<text>"` (read-back is
   the operator's job in Project Settings, so no `show` subcommand ships),
   mirroring `agent-seed/bin/verity-gh-token`: it reads the per-container capability from
   `VERITY_GH_TOKEN_CAPABILITY_FILE` and `curl`s an internal endpoint. `PATH` already
   includes `/opt/agent-seed/bin`, so it is available in every sandbox and every backend.
2. New internal route `POST /internal/project/memory` on the **non-published internal
   listener**, added to `preAuthPaths` (`packages/server/src/server.ts:2182`) similarly to
   `/internal/github/token` (`:2206`). It is reachable only container-to-container
   (`requestArrivedInternally`). **Gating:** the route/pre-auth entry keys only off
   `deps.ghTokenCapabilities` — **not** also `ghTokenMint`, which `/internal/github/token`
   additionally requires. Memory needs capability resolution, not token minting; copying
   the gh-token condition verbatim would wrongly disable memory in a deployment that has
   capabilities but no token-mint.
3. Authentication and project scoping reuse the existing capability registry: the server
   resolves the presented capability to `{ projectId, owner, repo }`
   (`packages/server/src/github-token-broker.ts:91`, `gh_token_capabilities.cap_hash`).
   **The sandbox never asserts its own project id** — scope comes from the server-side
   binding. The handler then does a read-modify-write on `project_settings.memory` for
   that `projectId` via `updateProjectSettings`.

Reusing the gh-token capability (rather than minting a second one) keeps provisioning
unchanged; the capability already identifies the project.

**Write-path caveat:**

- **Relay-only.** Every project sandbox receives a generation-bound capability from its
  mandatory project relay lifecycle. There is no non-broker/PAT provisioning mode and no
  fallback URL. `verity-memory` fails loudly when its capability file is absent.
- **Concurrent same-project writes.** The capability is **per-project**, issued once per
  project container (`provisioner.ts:1770`) and shared by every concurrent session of that
  project. Two sessions each calling `verity-memory append` are a read-modify-write **lost
  update** on the single blob. The operator's single-writer de-scoping covered only
  operator-vs-operator edits; agent-vs-agent is real. The store handler must therefore
  serialize the append (append server-side under a per-project lock / single UPDATE that
  concatenates, rather than client read-then-write), or accept occasional lost appends as
  a documented limitation.

### Write path B — the operator (UI)

`project_settings.memory` is surfaced as a plain multi-line text field in the Project
Settings screen, written through the normal operator API path that already updates project
settings. The operator can read, edit, prune, or clear it — this is the curation surface
that keeps the memory (and thus the injected prompt) from growing stale or bloated.

### Read path — automatic load at context init

The memory is folded into the runtime system prompt that is already transported to every
backend via `--append-system-prompt` (`packages/session/src/runner.ts:264`). Two things
about the real code path must be stated precisely, because the naive "the server appends
to the prompt at spawn" is wrong:

- **The prompt block is assembled inside `packages/session`, a deliberately
  project-agnostic, runtime-neutral layer.** `TURN_SYSTEM_PROMPT`
  (`packages/session/src/conductor.ts:47`) is fixed policy text; the server does not and
  should not reach in to append to it. Threading per-project memory therefore requires a
  **real new seam**, not zero plumbing: either a new optional field on the turn options
  that the server populates from `project_settings.memory`, or the conductor reading
  `project_settings` itself by `session.projectId`. This intentionally crosses the
  runtime-neutral boundary and should be designed as such.
- **Injection happens at context init, not every turn.** `appendSystemPrompt` is attached
  in `buildResumeOpts` (`conductor.ts:~1983`, the real project-session turn path via
  `dispatchTurn`) and `buildStartOpts` (`conductor.ts:~2025`, the concierge path), gated
  on `includeRuntimePrompt` — resume/live-stdin turns that continue an existing context
  already carry the policy and are **not** re-injected. So the memory rides the prompt
  **once per fresh backend context**, not on every turn.

Wrapped in a clearly delimited section (skipped entirely when memory is `NULL`/empty — no
empty header):

```
## Project memory (operator-curated; may be stale — verify before relying on it)
<memory text>
```

Consequences of "once per context init":

- **Every new session in the project — any backend, any container — starts with the
  memory in context automatically**, with no action from the agent and no PR-merge
  dependency. This is the goal and it holds.
- **Intra-session freshness is limited:** memory written *during* a session (by the
  operator UI or by that session's own `verity-memory append`) does not reach the already
  running context; it takes effect at the next fresh context (next session, or a turn that
  re-initializes context). Acceptable, but stated rather than implied.

### Agent instruction

A compact, backend-neutral `MEMORY_SYSTEM_PROMPT` is part of `TURN_SYSTEM_PROMPT`, so
every fresh context learns the memory command even when the project repository has no
`AGENTS.md`. It tells the agent: when asked to remember or save durable project
information, call `verity-memory append "<short factual note>"`; store only decisions,
conventions, or gotchas; write the note in English regardless of the conversation
language; never secrets or transient state. Keeping this guidance in the existing
context-init prompt avoids backend-specific discovery and avoids resending it on resume
turns. This makes "merk dir das" **reliable** — a single shell call instead of a
commit+push+merge round-trip — though it still depends on the model choosing to call the
binary; it is not fully deterministic.

### Security

Reusing the gh-token capability is **not** a no-op on the threat model, and this ADR does
not claim "no new security model." The gh-token broker's documented guarantee
(`github-token-broker.ts` header) is that a leaked capability only ever mints a
**scoped, ephemeral** GitHub token for its own project — the sandbox's legitimate git
identity. Adding a memory-write endpoint on the same capability grants a **new, durable,
cross-session influence channel**: text an agent turn writes is injected into the system
prompt of *every future session of that project, on any backend*, and it lands **before**
the operator reviews it in the UI (curation is after-the-fact). A single misbehaving or
compromised turn can plant standing text that later sessions read at system-prompt
altitude. This widens the capability's blast radius relative to ADR 0002's single-purpose
credential scoping.

We accept this at single-operator scale because: memory is operator-visible and prunable
in Project Settings; the injected block is explicitly framed as *operator-curated, may be
stale, verify before relying on it* (not authoritative instructions); the size cap bounds
volume; and the alternative (a dedicated second capability, below) buys authority
separation at real provisioning cost. If Verity moves to multi-tenant / multi-operator
projects, revisit with a dedicated write-only memory capability or an operator-approval
step before agent-written memory is injected.

## Alternatives considered

- **Git-committed `MEMORY.md` in each project repo (the git-file option).** Zero server code and works
  today, but: persistence depends on the model reliably committing + pushing (the exact
  failure the operator hit); memory reaches other sessions **only after PR merge**; each
  note pollutes git history and needs review; and the natural Claude affordance
  (`@AGENTS.md`) is backend-specific. Correct for content that genuinely belongs in the
  repo as versioned documentation, wrong for "have Verity remember this for me." Rejected
  as the primary mechanism; still available to operators who want repo-tracked notes.
- **Structured memory entries (rows with source + timestamp).** Enables independent
  operator/agent edits and per-entry deletion, but the operator explicitly de-scoped
  concurrent editing. Deferred; the single-blob column can migrate to a table later
  without changing the broker/injection contract if the need appears.
- **A dedicated `project_memory` table + second capability.** The benefit is genuine —
  **authority separation**: a memory-only capability could not also mint GitHub tokens, and
  vice-versa, keeping each credential single-purpose per ADR 0002. We defer it because at
  single-operator scale the added table and per-project capability provisioning outweigh
  that separation, and the "Security" section above bounds the reuse risk. This is the
  first thing to reach for if the blast-radius concern grows (multi-tenant projects).

## Consequences

- Persistent, immediate (next context init), cross-container, backend-neutral memory keyed
  per project, with no git-history noise and no merge latency.
- One new DB column + migration, one internal route, one seed binary, one context-init
  injection seam through `packages/session`, one compact shared runtime directive, and one
  UI field — mostly along existing patterns. It does **not** claim "no new security model":
  it widens the gh-token capability's authority (see "Security").
- The system prompt grows by the memory size **once per fresh backend context** (not per
  turn — resume turns are not re-injected); the soft size cap plus operator curation bound
  this.
- **Per-project only.** A truly cross-project ("global over all projects") memory is out
  of scope here — the capability is project-bound. A global tier would need a separate
  channel (e.g. a deploy-level setting folded into the same `appendSystemPrompt` block)
  and is left for a future ADR if wanted.
- **Broker-mode only** for agent writes; read/injection and operator edits work in all
  modes.
- Read-modify-write on a single blob races under **concurrent same-project sessions**
  (per-project capability), not just operator edits; must be serialized server-side or
  accepted as a documented lost-update limitation.

## Scope / open questions

- Exact soft size cap value and truncation/warn behavior on `append` (enforcement location
  is decided: shared store layer).
- Whether `verity-memory append` de-duplicates or blindly appends (start blind; revisit).
- Concurrent-append serialization: per-project advisory lock vs. a single concatenating
  `UPDATE` vs. accepting lost updates — pick during implementation.
- UI affordance: plain textarea vs. read-only preview + explicit edit; whether to show a
  provenance hint that the agent may have written it.
- Exact seam for injection: new turn-options field populated by the server vs. conductor
  reading `project_settings` by `session.projectId`.
