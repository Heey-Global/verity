# ADR 0005 — Naming & Layering (Server / Runner / Sandbox / Session)

**Status:** Proposed · **Date:** 2026-07-02

## Context

Verity's building blocks are named inconsistently, and the worst offender is
**"runner"**, which today means three different things:

- **ADR 0002** (North-Star, explicitly [omnigent.ai](https://omnigent.ai)-inspired):
  **Runner** = the whole sandboxed execution unit (container + worktree + net sandbox +
  credential broker); the control-plane is the **Server**.
- **ADR 0003**: the control-plane's deployable is called the **"Runner Image"** — which
  *contradicts* 0002 (there the control-plane is the Server, and the Runner is the
  per-session unit).
- **Code** (`packages/session/runner.ts`, plus "the runner" / "mid-turn runner" across
  `adapter-claude` and `mobile`): **runner** = the agent-turn **driver** — the process that
  spawns `claude -p`, drives its stream, and gates permissions.

Add the `verity-base` (image) vs `verity-devbase` (Feature) near-collision and the
vocabulary is muddy enough to slow design conversations. ("space" is *not* a term — it
never appears in the code.) This ADR fixes the vocabulary.

## Decision

Four roles, non-overlapping:

| Role | What it is | Where it runs |
|---|---|---|
| **Server** | the control-plane: orchestration, policies, shared history, the web/mobile/REST surfaces. Spins up Sandboxes. | the host (long-running service) |
| **Runner** | the agent driver: spawns and drives the agent (`claude -p` / codex / …), ingests its stream, gates permissions. | **in the Sandbox** (target) — today tangled in the Server (below) |
| **Sandbox** | the per-project isolated container / dev environment the agent (and, in the target model, its Runner) runs in. fs + network isolation. | one per project/session, beside the Server |
| **Session** | the logical, harness-agnostic execution context — the conversation / turn history. | logical (state in the Server's store) |

Mnemonic: **Server** orchestrates · **Runner** drives the agent · **Sandbox** is where it
runs · **Session** is the logical thread.

### Runner location: target vs. today

In the clean model the **Runner runs *inside* the Sandbox**, next to its agent; the Server
only orchestrates (spawns Sandboxes, collects events, applies policy). **Today the Runner
is tangled inside `packages/server`** and reaches into the Sandbox via `docker exec`
(`project-backend.ts` — "usually Docker exec into the project container"). ADR 0002 already
names this the missing Runner/Server boundary and sets "extract a clean Runner layer" as
the direction. This ADR adopts the **target** vocabulary; the extraction is tracked
separately.

**The extraction is not a cheap refactor.** Moving the Runner *into* the Sandbox inverts
today's control flow: permission-gating, stream ingestion, and transcript persistence
(`runner.ts`) currently run in-Server against the Server's DB/EventBus directly. An
in-Sandbox Runner needs a Server-facing callback channel (permissions, events, transcript),
and credential-brokering (ADR 0002 D4) becomes a cross-boundary concern. The vocabulary
change is cheap; the extraction it names is not.

### Delta from ADR 0002

ADR 0002 lumped the container + driver into one **Runner** and used **Sandbox** only for
the fs/net restriction layer. This ADR **splits** them:

- **Runner** narrows to the *agent driver* (matching the code's `runner.ts`).
- **Sandbox** is promoted from "fs/net layer" to the name of the **container / environment**
  itself. (0002 already leaned this way: *"Sandbox (fs+net) = per-project container"*.)

That split is what makes "Runner" stop colliding with `runner.ts`.

### Correction to ADR 0003

ADR 0003's **"Runner Image" → "Server Image"** (`deploy/Dockerfile` packages the
*control-plane* = the **Server**). This removes the direct contradiction with 0002.

## Artifact naming

| Artifact | Today | Canonical |
|---|---|---|
| Control-plane deployable (`deploy/Dockerfile`) | "runner image" | **`verity-server`** (Server image) |
| Sandbox image (`deploy/verity-base.Dockerfile`) | `verity-base` | **`verity-sandbox`** |
| Sandbox tooling Feature (`features/verity-devbase`) | `verity-devbase` | **`verity-sandbox-toolkit`** |
| A provisioned project container | "project / agent container" | **a Sandbox** |

`packages/session/runner.ts` keeps its name — "Runner" is now unambiguously the agent
driver.

## Rollout

**Rename first, atomically, as one PR** — the first step of the ADR 0004 build sequence, so
there is **no mixed-meaning interim** (the red-team's main objection: "Runner" meaning two
things at once for an open-ended period). One PR flips it all together:

- ghcr image names (`verity-base`→`verity-sandbox`), the Feature dir
  (`features/verity-devbase`→`features/verity-sandbox-toolkit`), `deploy/*.Dockerfile`,
  workflow names, ADR 0002/0003 term edits, and code identifiers/comments.
- **`renovate.json` `managerFilePatterns` in the same commit** — they hard-code
  `features/verity-devbase/…`; if they aren't moved in lockstep the pins **silently freeze**
  (no CI error — a supply-chain regression, since stale = unpatched).

"Runner" stays = the agent driver (as decided); we do not invent a new term, we just land
the one meaning everywhere at once. All subsequent build work uses the final names.

## Rejected

- **Runner = the container** (ADR 0002's original lumping, and the literal Omnigent
  reading) — collides with the code's established `runner` (turn driver) and blurs
  driver-vs-environment. Splitting into **Runner + Sandbox** is clearer, and matches how
  the code already uses "runner".
- **`verity-sandbox-base` / `verity-sandbox-image`** for the image — `-base` implies a
  foundation to build on, but blank repos run this image **directly** as the Sandbox (and
  devcontainer repos build on their *own* base, not this one); `-image` is redundant (all
  these artifacts are images) and inconsistent with `verity-server`. Chose the bare
  **`verity-sandbox`**, parallel to `verity-server`.
