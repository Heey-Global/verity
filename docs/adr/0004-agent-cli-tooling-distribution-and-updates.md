# ADR 0004 — Agent CLI Tooling: Distribution & Update Strategy

**Status:** Proposed · **Date:** 2026-07-02

> **Naming:** this ADR uses the **ADR 0005** vocabulary (Server / Runner / Sandbox /
> Session; `verity-server` / `verity-sandbox` / `verity-sandbox-toolkit`). The mechanical
> rename lands **first** in the build sequence, so prose and code agree from the start. Where
> a current file path is referenced it keeps its pre-rename name (e.g. `features/verity-devbase/`).
>
> This revision folds in a 5-perspective review (architecture / security / DevOps / DX /
> red-team) — see the companion **`docs/adr/0004-review-notes.md`**, which is not part of the
> public snapshot.

## Context

Verity Sandboxes ship four vendor coding-agent CLIs — **claude-code**, **codex**
(`@openai/codex`), **opencode** (`opencode-ai`), **pi** (`@earendil-works/pi-coding-agent`).
All four are global npm packages.

Trigger: a new Claude version (Fable 5) did not appear because the pinned CLI was stale
**and** the in-container auto-updater was silently failing (`no_permissions`, root-owned
`/usr/local` prefix). Investigating that surfaced the question this ADR settles: **how do
these CLIs get into Sandboxes, and how do version updates propagate — without breaking
reproducibility or the supply-chain hardening?**

**Scope note (today vs. target).** Repos without `.devcontainer/` run on the baked Sandbox
image (`verity-sandbox`). Repos with `.devcontainer/` are built by the Server with
`@devcontainers/cli`, with the bundled Verity toolkit Feature injected as an additional
Feature. D3/D5 below still describe the digest/provenance target; their prerequisites are
called out explicitly so the build doesn't inherit the review's findings as bugs.

## Findings (constraints that shaped the decisions)

1. **Root-owned install breaks the in-container auto-updater.** The toolkit installs into
   `/usr/local` (root-owned); the updater runs as the unprivileged user → `no_permissions`.
   The legacy dev-base used a user-owned `~/.npm-global` prefix, so its updaters worked —
   the verity migration silently regressed this.
2. **The hardening is fundamentally incompatible with in-container npm self-update.**
   `ignore-scripts=true` skips npm lifecycle scripts, but **claude-code** (`node install.cjs`)
   and **opencode** (`node postinstall.mjs`) *require* postinstall to copy their native
   binary over a placeholder stub. A runtime `npm install -g` self-update would install a
   **broken** binary. So in-container self-update is off the table regardless of permissions.
3. **No live pull.** The toolkit is embedded into an image at build time; there is no
   registry fetch into a *running* Sandbox. A new CLI version always requires a **rebuild/
   recreate** of the consuming artifact.
4. **The toolkit is the single source; consumers embed it at build time.** The baked Sandbox
   image bakes it (`deploy/verity-base.Dockerfile`); the Server image bundles it for
   injection (`deploy/Dockerfile` `COPY … /opt/verity-features/…`); dev Sandboxes get it
   injected via `--additional-features`.
5. **The injection model is intentional.** Dev environments bring their own base + tools;
   the toolkit merges **on top** non-invasively. One shared base for everyone is not viable.
6. **Restart ≠ Rebuild.** Toolkit installs at build/create, not on start. Only a rebuild
   re-runs `install.sh` (and the npm postinstall). Server-provisioned Sandboxes are
   ephemeral (fresh build per session) → pick up the newest toolkit automatically.

## Decisions

Distribute at **build time**, pin via **Renovate**, disable in-container auto-updaters for
**all four**, publish the toolkit and reference it **by digest**, and surface updates
per-project in the app.

### D1 — Pin all four CLIs; Renovate drives bumps, **merge is manual**

Each CLI is a pinned version in `install.sh` (mirrored as a manifest option default),
tracked by the `renovate.json` custom managers. Per **org-wide Renovate policy**: **manual
merge, no auto-merge**, with **stability days** (cooldown) applied org-wide. Our project rule
keeps only the **grouping** (the four CLIs land in one PR); it does **not** set `automerge`
or a custom `schedule`. This gives one reviewable, cooled-off PR — a human sees every bump.

### D2 — Disable the in-container auto-updater for **all four** CLIs (uniform)

They fail today (permissions) and would install broken binaries if "fixed" (finding 2).
No CLI self-updates in-container; updates arrive only via image rebuild / toolkit republish.
Disabled uniformly in `install.sh`:

- **claude-code** — `/etc/claude-code/managed-settings.json` → `{"autoUpdates": false}`.
- **opencode** — `OPENCODE_DISABLE_AUTOUPDATE`.
- **codex** — its config knob / notify-only (verify at implementation).
- **pi** — its documented "disable update" mechanism.

### D3 — Publish the toolkit to ghcr; reference it **by digest**

Publish (`devcontainers/action`) to `ghcr.io/heey-global/verity/verity-sandbox-toolkit`. The
provisioner references it by **digest** (immutable), Renovate-bumped — **not** a floating
`:1` tag. A human-readable floating tag may exist, but never in the resolve path. Rationale:
a digest is content-addressed, so identity changes iff content changes → the cache reacts
and integrity holds (Topic: identity). A CLI bump then becomes a **KB-sized republish**, not
a heavy image rebuild.

**Consequence — conditional, not present-tense:** the Server image becomes CLI-agnostic
(needs only `@devcontainers/cli`) and drops out of the CLI-bump rebuild path **once** the
bundled `COPY` (`deploy/Dockerfile:137`) is removed and the ref points at the ghcr digest.
Until that cutover, the Server image still bundles the toolkit.

**Prerequisites (build-blocking, not follow-ups):**
- **Toolkit `version` is release-time, via release-please** (superseded the original
  per-PR auto-bump + CI-guard design). The manifest's top-level `version` is a sentinel
  (`0.0.0-managed`); the real shared OCI-artifact version is derived from the
  Conventional-Commit history by **release-please**. It accumulates changes in a
  dedicated release PR; only merging that PR creates `v<semver>` and lets the three
  publish jobs in `.github/workflows/release.yml` stamp the shared version onto
  toolkit/server/sandbox. Routine branches do not choose or bump a version — the old
  `scripts/auto-version.mjs` /
  `check-feature-version.mjs` / `check-image-version.mjs` and their CI jobs were removed.
  (Renovate still bumps the CLI pins; those changes just ride the next release.)
- **Identity keyed on digest, not the semver `version`** in `devcontainerContentHash`.

### D4 — Keep the supply-chain hardening intact

CLI installs (F4/F4c) run **before** the F5 `ignore-scripts` hardening (`install.sh`), so
build-time postinstall runs correctly and the hardening governs only later *project*
installs. **Residual:** a project `.npmrc` can re-enable scripts; since agents run on
*untrusted* repos, that is a real (sandbox-contained) vector — tracked as a follow-up
(neutralise repo `.npmrc` script-toggles for the agent user). **Fail-loud:** if a CLI was
installed but F5 is skipped (npm absent), that is a hard error, not a warning.

### D5 — Detection + in-app update UX (per project)

A new version lands only on rebuild/recreate (finding 6), and taking it interrupts a running
Sandbox → make it explicit and per-project.

**Detection (the polling engine — new work):**
- **Persist per project what it was built from**: Sandbox-image **digest** + toolkit
  version/digest + **consumption mode** (baked vs. injected). This "built-from" record does
  not exist today; it is also the observability surface ("which Sandbox runs which version").
- **Poll centrally, once per cycle (~60 min):** a Server background job fetches the current
  published Sandbox-image digest + toolkit version/digest into one "current" record — **one
  registry lookup per cycle, not per project** (rate-limit safe).
- **Reconcile per project (cheap DB pass):** compare built-from vs. current, **only for the
  component the project actually uses** (baked → image digest; injected → toolkit). Differ ⇒
  `update_available` + which component + version delta. A project that **pins its own** CLI
  version suppresses the fleet marker for that component ("pinned by project").

**Update classification (security vs. normal) — from publish metadata, not the registry:**
the "security" bit and the changelog are known at **Renovate/CI** time, not derivable from a
version number. CI **stamps** them onto the published artifact (OCI annotation / release
record): `{version, class: security|normal, changed: [...], advisory: [...]}`. The poller
reads these → the marker knows security-vs-normal and *what changed* for free.

**UX:**
- **Project overview icon** — two states: **normal update** vs. **security update**.
- **Action = "Update & restart"** (not the scary "recreate"), with inline reassurance
  "your uncommitted changes are preserved" (the workspace is a persistent bind-mount).
- **Recreate must actively fetch** the current image/toolkit — not reuse a locally-present
  stale tag (see Recreate below). Recreate is **idempotent**.
- **Drain via the canonical `status` event:** `running` → offer "update after this turn"
  (drain) or "interrupt now"; idle/`awaiting_input`/`completed` → update immediately.
- **Settings (auto-update policy), nightly in an idle window (with drain):** three levels —
  **Off/manual** (default) · **Security only** · **All** — per project, with a global
  default. This is also the staleness backstop (drift-by-neglect).
- **Offline:** the marker degrades gracefully ("last checked Xh ago") if the poll fails.
- **Batch update** across projects ("update all idle") — **Phase 2** (the nightly setting
  covers the automatic case).

### D6 — Toolkit consumption: local `COPY` in-repo, external ghcr **digest** out-of-repo

The toolkit and the in-repo images live in the same repo → split by locality:
- **In-repo** (the baked Sandbox image, `deploy/verity-base.Dockerfile`) keeps the local
  `COPY` + `RUN install.sh` — same commit, no skew, no publish-before-build ordering.
- **Out-of-repo** (the Server injection, external dev repos) reference the published
  `ghcr.io/heey-global/verity/verity-sandbox-toolkit` **by digest** (D3).

## Recreate must actively fetch (not reuse a stale local image)

For a **baked/blank** project, "Update & restart" only helps if the new Sandbox image is
actually fetched. Today `createContainerPullingIfMissing` pulls **only on `image_not_found`**
(`provisioner.ts`), and the default image ref floats — a moved tag already present locally is
never re-pulled (the ADR 0003 stale-image class). Fix: pin the default Sandbox image **by
digest** (Renovate-bumped) and have recreate **force a pull** of the target digest.

## Security

- **Integrity via digest (now).** Referencing the toolkit and Sandbox image by digest gives
  content integrity and kills silent tag-repointing — the main supply-chain concern.
- **Signing/provenance (cosign) — follow-up ticket**, not day-1 (private ghcr; compromised
  CI/registry credential is not a day-1 threat). Take **npm provenance** for the four vendor
  CLIs where available (cheap).
- **CVE lane.** Disabling auto-update + manual merge + operator-driven update adds latency.
  Security advisories (`vulnerabilityAlerts`) must be surfaced **separately and urgently**
  (not folded into the grouped PR), and the D5 marker flags them as **security** so the
  operator prioritises (and the nightly "Security only" setting can apply them).
- **No auto-merge** (D1) removes the "compromised patch auto-bakes fleet-wide" path; the CI
  smoke test (below) gives the human merger a real go/no-go signal.
- **`ignore-scripts` residual** (D4) and **F5 fail-loud** (D4).

## CI/CD on a version bump

Trigger: a Renovate pin-merge under the toolkit's dir. Target jobs
(independent → parallel; digest model needs no publish-first ordering for the
in-repo base):

| Job | Purpose | Status |
|---|---|---|
| **Publish toolkit → ghcr** (digest, `version` bump, security/changelog metadata) | injection + external repos | ❌ to build |
| **Rebuild Sandbox image** (`verity-sandbox`, digest-tagged + rollback `:sha-` tag) | baked/blank projects | ⚠️ exists as `verity-base.yml`; add rollback tag |
| **Smoke test all four CLIs** (actually launch `--version`/`--help` via a pseudo-terminal) | gate before merge/publish | ❌ to build |
| **Server image** (`verity-server`, digest-tagged + rollback `:sha-` tag) | deployable control-plane image | ✅ exists as `verity-server.yml` |

## Consumers & what rebuilds on a bump (target)

| Consumer | How the toolkit arrives | On a CLI bump |
|---|---|---|
| **Sandbox** (server-provisioned, ephemeral) | injected by ghcr **digest** | next session build — automatic |
| **Server image** | runs `devcontainer build`; carries no CLIs *(after cutover)* | not on the CLI-bump path |
| **Project dev Sandbox** (own base + tools) | injected by ghcr digest | on next "Update & restart" |
| **Baked Sandbox image** (blank repos) | bakes the toolkit (local `COPY`) | automated image rebuild |

## Alternatives considered (rejected)

- **In-container live self-update** — breaks on `ignore-scripts`/postinstall (finding 2).
- **Revive the updater by user-owning the prefix** — fixes permissions but still broken by 2.
- **One shared base image, everyone `FROM verity-sandbox`** — can't serve heterogeneous dev
  environments.
- **Floating `:1` / `:latest` in the resolve path** — cache doesn't react, no re-pull, no
  integrity. **Superseded by digest (D3).**
- **Build blank repos on-the-fly** (`devcontainer up --override-config`) — every provision
  reinstalls the whole toolchain → slow cold start; the baked image pre-bakes it once.

## Build sequence (backlog)

1. **Rename PR** (ADR 0005) — atomic, incl. `renovate.json` `managerFilePatterns`; first, so
   everything after builds on final names.
2. **Digest identity + `version` auto-bump + CI guard** (D3 prerequisites); recreate force-pull.
3. **Publish workflow** → ghcr (digest + `version` bump + security/changelog metadata).
4. **Poller + per-project built-from persistence + marker** (icons; security from metadata).
5. **codex/pi disable + smoke-test CI + F5 fail-loud + pin sync-check.**
6. **D5 settings** (nightly auto: Off/Security/All, drain via `status`).

## Work already in flight (PR #343)

- **D1 pins** for all four CLIs (`install.sh` + manifest + `renovate.json` managers). ✓
- **D2 (claude)** managed-settings `autoUpdates:false`. ✓ (opencode/codex/pi pending — D2 4/4.)
- **`renovate.json`**: dropped `automerge` + `schedule`, kept grouping (D1). ✓

**Follow-up tickets:** cosign/provenance; `.npmrc` script-toggle neutralisation; full pin
single-source (sync-check first); batch update (Phase 2).
