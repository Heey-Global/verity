# ADR 0001 — Model/Backend Abstraction (multi-provider agents)

**Status:** Proposed (v2 — spiked & measured) · **Date:** 2026-06-25

## Context

Verity drives Claude Code by shelling out to the `claude` CLI and adapting its
`stream-json` output into a canonical `AgentEvent` log (pglite). This hard-couples the
control-plane to Anthropic. Two needs forced a rethink:

1. **Usage limits.** The operator hit the Claude Max subscription limit and wants to keep
   working by switching to other models.
2. **Multi-model.** Use Claude when it fits; cheaper open models (DeepInfra: Kimi K2,
   GLM-4.6, …) otherwise.

Operator constraint: *don't over-couple to the `claude` CLI* — switching must be
transparent behind an abstraction.

## Decision

A **backend interface** with two concrete backends, behind one canonical event model.

### Backend contract

Beyond "run a turn", the interface MUST abstract the full turn lifecycle (the current
Conductor is 100% process-lifecycle-coupled — review finding H2):

| Capability | Claude Code backend | OpenCode backend |
|---|---|---|
| run turn from history | `claude --resume` (materialized `.jsonl`) | `POST /session/{id}/message?directory=…` |
| event stream | `stream-json` stdout → `AgentEvent` | SSE `GET /event?directory=…` → `AgentEvent` |
| cancel (#79) | SIGTERM the child | `POST /session/{id}/abort` |
| busy / turn-end | process alive / `result` + stdout-EOF | `GET /session/status`, `POST /session/{id}/wait` |
| mid-turn steer (#101) | held-open stdin | (queue-only initially; verify) |
| permission gating | `--permission-mode` / allowed/disallowedTools (§5b) | `GET /session/{id}/permission` + `…/permission/{reqID}/reply` |

> Spawn = run with empty history. Mid-session switch = run with existing history. Same
> operation, parameterised by the starting history.

### The two backends

| Backend | Models | Auth / billing | Process model |
|---|---|---|---|
| **Claude Code** (`claude` CLI) | Claude | Max **subscription** (OAuth) | **1 process : 1 session**, transient per-turn today; warm across turns under #101 |
| **OpenCode** (`opencode serve`) | DeepInfra (Kimi K2, GLM-4.6…), 75+ providers, OpenAI-compatible | **API key** (pay-per-token) | **1 server : N sessions** across N worktrees (Spike 2) |

> OpenCode *can* run Claude, but only via a pay-per-token API key — Claude Pro/Max via
> third-party tools is prohibited by Anthropic (OpenCode removed it in 1.3.0). So Claude
> stays on Claude Code to use the subscription.

### Storage: the DB is the cross-backend truth (two stores)

- **Canonical `events` log** — written by **every** backend's adapter (the OpenCode adapter
  must PERSIST, not just stream). The backend-neutral, cross-backend truth; the source for
  re-seeding into ANY backend on a switch.
- **Verbatim Claude transcript** (`transcript_lines` table) — the raw Claude `.jsonl`, lossless,
  materialized to disk via `materialize`/`materializeToDisk` (transcript-sync.ts:186) for
  Claude's own lossless resume (Claude→Claude). OpenCode needs no such artifact — it
  re-seeds from the canonical log (a message array).

### Model selection & routing

- **Manual per-session picker** (a menu in the session, like the branch switcher). NO
  automatic failover — the operator chooses. **Mid-session switching is supported.**
- **Routing — the model-string FORMAT is the contract** (decided 2026-06-25, slice 3a,
  superseding the earlier "explicit `{backend, model}`, not a model-string guess" line —
  review L1, retracted). A **provider-qualified** model (`providerID/modelID`, contains a
  `/`, e.g. `deepinfra/zai-org/GLM-5`) routes to the OpenCode backend; a **bare** model
  (`claude-opus-4-8`, `sonnet`, no `/`) routes to Claude Code. This is safe because Verity
  OWNS the picker and the stored model strings: Verity never emits a slash-prefixed Claude
  id (no `anthropic/claude-…` proxy form). Rationale for retracting L1: it avoids a store
  schema migration (no separate `backend` column) for behavior the picker already fully
  determines; the provider prefix IS the explicit backend marker, just encoded in the model
  string. If a future need arises to run a slash-prefixed Claude id (a gateway/proxy), add
  an explicit `backend` discriminator then — until then, format-as-contract is sufficient.

### Switch mechanics

Exactly ONE backend active per session at a time. A switch is a one-time **handoff**:
render the canonical log into the target's input format, the target ingests it ONCE, then
live. Per-SWITCH cost, not per-turn (mental model: cold-start the target from the DB truth).
The old backend instance goes idle and is dropped by the warm-pool eviction.

Direction asymmetry:
- **→ OpenCode** (incl. Claude→OpenCode): tractable — build a message array from the
  canonical log; lossy bits (Claude "thinking") don't matter cross-backend.
- **→ Claude** (incl. OpenCode→Claude): append synthetic Claude-format lines (the other
  backend's turns) to Claude's verbatim transcript, then materialize + `--resume`.

**Cross-backend tool history (review H1):** prior `tool_call`/`tool_result` blocks are
**flattened to plain text** in the re-seeded history (safe — avoids orphaned-tool-call
rejections in the target). Native tool-call fidelity is preserved only WITHIN a backend
(Claude→Claude uses the verbatim transcript). The foreign-append path itself is proven
(Spike 1).

## Spike results (2026-06-25)

- **Spike 1 — `claude --resume` foreign-append = GREEN.** Injected a fact Claude never
  authored ("build 4815") into a transcript, updated `last-prompt.leafUuid`, resumed →
  Claude answered with the injected fact (same session id). So OpenCode→Claude is feasible.
  Caveat: proven with plain TEXT turns; foreign TOOL-CALL blocks are flattened to text
  (see H1) — a fidelity follow-up, not a blocker.
- **Spike 2 — one OpenCode server spans many worktrees = CONFIRMED.** `opencode-ai@1.17.11`,
  `opencode serve`, live-created sessions in two different dirs on one server via
  `POST /session?directory=X`. So ONE shared `opencode serve` for all OpenCode worktrees.

## Resource model

Warm-pool with idle-eviction, **RAM-budgeted — NOT all sessions permanently on**.

- Idle streaming `claude` ≈ **214 MB RSS** each (1:1 per session). dev-server: 15 GB /
  ~9 GB available → ~10–15 always-on comfortable (~2–3 GB); 30 too tight (~6.3 GB + active
  turns need more + opencode/metro).
- OpenCode multiplexes (1 server : N sessions) — cheap; no per-session process.
- Keep a backend session HOT only while active; idle → cold in the DB, reconstructed on
  demand. Warm-pool size is a RAM-vs-latency budget.

## Token reality (measured — corrects v1)

- **Process warmth is NOT a token lever.** A fresh `claude --resume` respawn cache-READs
  the history identically to a warm process (measured, one turn of a small session:
  34,630 cache-read / ~135 created). The prompt cache is **server-side + TTL-bound**
  (5 min default / 1 h ephemeral tier — the 1 h tier was in use in our measurement); a warm
  local process does not keep it alive. So eviction timing is a MEMORY/latency decision,
  not tokens.
- The token cost = **context size** (the inherent per-turn context re-read — which summed
  to ~1.17B cache-read *aggregate* across the 3 live sessions over 447 turns, NOT per turn)
  + **cadence vs cache TTL** (gaps beyond the TTL force a cache-creation; baseline: creation
  = 29% of the cache *cost*). Real levers: keep context small — **#138** (sub-agent
  delegation), **shorter sessions**, **`/compact`** (manual — **no auto-compact**, operator
  call). **#101** buys latency + mid-turn steering, NOT tokens.
- Provider-switch (Kimi/GLM via OpenCode) is the real lever against the *limit* itself —
  cheap pay-per-token tokens when the Claude subscription is exhausted.

## Per-backend isolation (review H3 / M2)

- **Usage (H3):** tag `result`/usage events with `{backend, model}` so per-session totals
  split per backend (the `result` schema has no such field today — add one). Blending
  subscription (Claude, 5 h quota) and pay-per-token (OpenCode) into one sum is the wrong
  number for quota decisions.
- **Permissions (M2):** OpenCode runs tools under its OWN config; Verity must bridge its
  permission gating via `GET /session/{id}/permission` + `…/reply` (not leave it
  ungoverned). Mirror the §5b posture per backend.

## Consequences

**Positive:** transparent multi-model; best Claude harness on the subscription; cheap open
models when Claude is exhausted; OpenCode multiplexes cheaply; the canonical-log contract
makes spawn and switch one mechanism; both switch directions are spiked feasible.

**Out of scope (later):** automatic failover; third-party context-compression proxies
(e.g. headroom); auto-compact.

**Open follow-ups:** foreign TOOL-CALL fidelity on →Claude (currently flattened to text);
ongoing token tracking/re-analysis (per-turn cacheCreation-vs-cacheRead + inter-turn gaps —
events API lacks timestamps, needs a store query); choose between the OpenCode `/session/*`
(directory-aware) and `/api/session/*` API surfaces.

## Amendment 1 (2026-08-25) — every backend is an ACP profile

The abstraction held; the two implementations behind it did not survive contact with
ADR 0012. Both columns of the "Backend contract" table and both rows of "The two
backends" describe transports that no longer exist: the `claude` CLI with its
`stream-json` stdout was removed in ADR 0012 Amendment 1, and the `opencode serve`
HTTP/SSE client in Amendment 4. Read those tables as the 2026-06-25 statement of
what a backend must be able to do, not as a description of how either one does it.

What actually satisfies the contract now is one agent-neutral ACP client
(`packages/session/src/acp-backend.ts`) plus a per-agent profile. Turn lifecycle,
cancel, mid-turn steering, and permission gating are single implementations that
every backend shares, which is a stronger form of the decoupling this ADR asked for
than two hand-maintained protocol adapters were.

Three specifics this ADR states that are now different:

- **Process model.** "1 server : N sessions across N worktrees" is gone. OpenCode is
  a per-session stdio child in the project Sandbox, like Claude and Codex — the
  multiplexing advantage in "Resource model" no longer applies, and neither does
  the shared-server blast radius that came with it.
- **Permission bridging (M2).** The bridge is no longer `GET /session/{id}/permission`.
  OpenCode's posture is an ACP session config option: Verity collapses its own
  postures into `plan` and `build`, and the shared loop's permission cards cover the
  per-tool decisions. The §5b requirement to mirror the posture per backend is
  unchanged and is enforced in the profile.
- **The picker catalogue.** Provider enumeration over `GET /config/providers` is gone
  with the HTTP API; the OpenCode entries in the picker are the operator's pinned
  `VERITY_EXTRA_MODELS` list, and `VERITY_OPENCODE_ENABLED` turns the route on.

The routing rule in "Model selection & routing" is untouched and remains the
contract: a provider-qualified id routes to OpenCode, a `codex/`-prefixed id to
Codex, a bare id to Claude. Its safety argument — that Verity owns the picker and
the stored strings — is what let the transport underneath be replaced twice without
a store migration.

## Related

- #101 — persistent streaming-stdin Claude session → becomes the *Claude-backend
  implementation* of the steer/turn-lifecycle contract, NOT the runner itself. (Latency +
  steering, not a token fix.)
- #138 — sub-agent delegation directive → a Claude-backend runner option; the real token
  lever (smaller context).
