# ADR 0002 — Credential & Runtime-Isolation Architecture (North Star)

**Status:** Proposed · **Date:** 2026-06-30

## Context

A run of session-tooling breakages (sessions intermittently unable to `git
push`, sign commits, or use `gh`) exposed that Verity's credential and runtime
concerns are cobbled together rather than cleanly layered:

- **gh decoupled from its token.** `c860b72` masked `/etc/profile.d/gh-token.sh`
  to keep the raw token out of the agent shell env. `git push` kept working
  (inline file-reading credential helper in `~/.gitconfig` reads `~/.gh-token`,
  no env), but `gh` broke because it expects `GH_TOKEN`. The runtime-neutral
  `agent-seed/bin/gh` wrapper now reads the mounted token file only for the child
  `gh` process and overrides stale inherited token env.
- **Stale containers drop signing.** Commit signing relies on SSH-key mounts
  the provisioner adds from the Verity settings record (`da57338`). Containers
  created before that change (e.g. `dev-heey-global--verity`, created
  2026-06-28, vs `dev-heey-global--deep-ocr`, created 2026-06-29 after the
  change) never received the mounts. A restart does **not** heal this — mounts
  are fixed at container-create time; only a re-provision does.

Both are symptoms of one root pattern: **credentials are injected at
container-create time with no clean rotation/propagation, and the runner
concerns (provisioning, exec backends, worktrees) are entangled with the server
concerns (API, history, settings) inside `packages/server`.**

**Inspiration.** [omnigent.ai](https://omnigent.ai) articulates the clean
layering Verity is organically becoming: **Runner** (wraps any agent in a
sandboxed, uniform session) → **Server** (policies + shared history + multi-
surface API) → **Session**, with first-class **Secure OS Sandbox** (fs + network
restriction) and a **Credential-Broker** that "hide[s] credentials from the
agent, and broker[s] access to them". Verity already has the pieces; the
boundaries are blurred.

## North-Star layering (aspirational framing)

| Layer | Responsibility | Verity today | State |
|---|---|---|---|
| **Runner** | wrap an agent in a sandboxed session (container + worktree + net sandbox + credential broker) | per-session worktree + `conductor`/`DockerExecBackend`, provisioner | **tangled** inside `packages/server` |
| **Server** | policies, shared history, surfaces (web/mobile/REST) | `packages/server` + `store` + `events` + `mobile` | present, also does Runner jobs |
| **Session** | uniform execution context across harnesses | `packages/session` | present |
| **Sandbox** (fs+net) | filesystem + egress restriction | per-project container + (planned) egress proxy | emerging |
| **Credential-Broker** | hide creds from agent, broker access | the secret-proxy below | **this ADR** |
| **Policies** | cost budgets, access control | mostly absent | gap / future |
| **History** | full, shareable run history | `events` + transcript store + PR status | present |

The "frickel" feeling has a concrete name: **the Runner/Server boundary is
missing.** The long-term direction is to extract a clean Runner layer; this ADR
nails the credential and isolation decisions that sit inside it.

## Decisions

### D1 — Three-tier credential scoping

- **Global (Verity instance):** GitHub App credentials (App ID + private key —
  the root that mints per-repo tokens; replaces the on-disk `.pem`), SSH signing
  key (the `heey-dev[bot]` identity) + `allowed_signers` + `known_hosts`, git
  identity defaults.
- **Project (per repo):** project Doppler service token (user-entered), scoped
  GitHub token (**derived** — minted from the global App, 1 h TTL, ~50 min
  refresh), project runtime/dev-server config.
- **Session (ephemeral):** worktree + branch, the dev-server *target*, agent/
  model selection + transcript. Sessions **consume** injected creds; they never
  **store** them.

### D2 — Isolation granularity: **Model C**

Sessions of one project are the **same trust domain** (same repo, same per-repo
token, same secrets), so per-session isolation adds negligible *security*; the
meaningful security boundary is **project-level**, already provided by one
container + one per-repo token per project. Within a project the real blast
radius is *operational*, not security.

- **Project = container = security boundary** (one per repo).
- **Multiple named dev servers per project** — each server has a stable identity,
  process files, worktree, and globally leased host port. Runtime operations use
  `/dev-servers/:id/runtime`; there is no project-wide implicit server owner.
- **Strong worktree isolation** — separate branches (git-native: a branch checks
  out in only one worktree; commits in X never touch Y).
- **Per-worktree `node_modules`, hardlink-seeded** from the canonical project
  `node_modules` at spawn (`cp -al` — instant, ~0 disk; a session's own
  `npm install` writes new inodes, so siblings/clone are untouched, only diffs
  cost disk; reflink/CoW where the filesystem supports `cp --reflink`). This
  relies on package managers replacing files via write-new-then-rename (the
  standard) rather than in-place edits. Package-manager-agnostic; resolution
  finds the worktree's own
  `node_modules` first so the switchable dev server uses the selected session's
  deps. The canonical `node_modules` is installed once at provision + refreshed
  on lockfile change.

*Rejected:* per-session container (A) and per-session port/process (B) as
over-isolation for a single trust domain. Bonus of C: the credential broker +
token + signing are wired **once per project container**, not multiplied per
session — directly removing the per-container multiplication that caused the
incident.

### D3 — Storage = DB; runtime delivery is ephemeral

The DB is the single source of truth for settings/secrets (encrypted at rest —
relates to #240). No secret file is a source of truth.

Secrets may still be materialized at runtime when an existing tool requires a
file or environment variable contract:

- Git/SSH signing material can be rendered by the server into short-lived,
  server-owned files with restrictive permissions and mounted read-only into
  the project container.
- Doppler tokens are stored in project settings and projected into the
  `docker exec` environment for agent/runtime commands; they are not persisted
  as `.env` files in the normal write path.

The important boundary is ownership: agents consume compatibility files/env;
they do not generate, discover, or persist the canonical secret.

### D4 — Delivery = Credential-Injection Egress Proxy ("secret-proxy")

The container/agent holds only a **placeholder**; the Verity egress proxy swaps
in the real secret for requests to **allow-listed hosts**. Properties:

- The real token **never enters the container** — only the placeholder appears
  in logs, transcripts, and model context. A leaked token is worthless (works
  only through the proxy, against allowed hosts).
- Default-deny egress allow-listing → **exfiltration control** for running
  agents (orthogonal bonus).
- **Cost:** to inject into HTTPS the proxy must MITM TLS (a trusted proxy CA in
  each container; the proxy sees egress plaintext). This is the same trust level
  as the Verity server, which already holds all secrets + the master key.

This supersedes an earlier "pull-at-use cred-API" idea for outbound tokens —
proxy-injection is strictly better because the real token never lands in the
container, even transiently.

### D5 — Commit signing = DB-backed compatibility first, server-side later

Signing is a local crypto op, not an outbound bearer request, so the proxy
doesn't cover it. The current implementation keeps the DB as source of truth
and materializes the configured signing key/public key/known-hosts/signers into
server-owned files before container creation, preserving Git's file-based
interface.

A later hardening step can replace the mounted private-key compatibility file
with a `gpg.ssh.program` / `gpg.program` wrapper that sends the payload to a
Verity signing endpoint; the server signs with the global key and returns the
signature.

### D6 — Proxy topology = per-project (auto-simplified by Model C)

Because all sessions of a project share scope (D2), the proxy is naturally
**per-project** and needs no per-session secret-*scoping*. A short-lived,
server-minted **per-session bootstrap token** remains, demoted from a scoping
mechanism to an **audit/identity tag** (who pulled what).

### D7 — Signing key is global

One bot identity (`heey-dev[bot]`). Per-project signing keys would mean N keys
to register in `allowed_signers`/GitHub with no real isolation gain (the
token-scoping is the security boundary, not the signing key).

## Open questions

- **Doppler under the proxy:** current implementation injects the DB-backed
  project Doppler token into runtime env. A later proxy can inject the token on
  calls to the Doppler API so the real token never enters the container.
- **Runner/Server extraction sequencing:** how far to refactor the layer
  boundary vs. let it emerge incrementally.

## Rollout phases

- **Phase 0 — Incident stabilization** (independent of the redesign): wire `gh`
  to the file token through `agent-seed/bin/gh`, move code review marker writes
  to the runtime-neutral `verity-code-review mark` command, and re-provision stale
  containers so signing mounts and `/opt/agent-seed` land. These are consistent
  with the target.
- **Phase 1 — DB storage + ephemeral compatibility delivery** (relates #240,
  #224): settings/secrets in the encrypted DB; file/env materialization only at
  runtime boundaries.
- **Phase 2 — Secret-proxy + server-side signing** (D4/D5): egress proxy with
  credential injection and signing endpoint/wrapper.
- **Phase 3 — Model C runtime** (D2): single switchable dev server + per-worktree
  hardlink-seeded `node_modules`.
- **Phase 4 — Runner/Server layer extraction** (north-star framing).

## Consequences

- The incident fix (Phase 0) is the first concrete step toward — not a
  throwaway band-aid against — the target architecture.
- Relates to #240 (encrypted DB secret storage), #224 (agent runtime settings:
  secrets/git policy), #174 (per-project containers).
