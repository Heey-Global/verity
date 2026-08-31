# ADR 0003 — Verity Runner Image & Deployable Packaging

**Status:** Proposed · **Date:** 2026-07-01

> **Terminology corrected by [ADR 0005](0005-naming-and-layering.md).** This ADR's
> "Runner Image" (the control-plane deployable) is now the **Server image**
> (`verity-server`), and the "Verity base image" is the **Sandbox image**
> (`verity-sandbox`, `deploy/verity-sandbox.Dockerfile`), built with the
> **`verity-sandbox-toolkit`** Feature (`features/verity-sandbox-toolkit/`). The
> decision content below is unchanged; read the artifact names through 0005. The
> historical `dev-base` / `dev-server` references describe the pre-Verity state and
> stay as-is.

## Context

Verity's control-plane is functionally complete but **coupled to the dev-server
host**. Today it runs as a dev-server-managed project container (`dev-verity`,
image `claude-dev-verity` built `FROM dev-base` via a per-project
`.dev-server/Dockerfile`), reaching Docker through the shared
`tecnativa/docker-socket-proxy`, storing its pglite DB inside a project
bind-mount, and taking its secrets from **host-mounted files** (the GitHub App
`.pem`, SSH keys) with **no `VERITY_SECRET_KEY` set**. The app-driven,
encrypted-secret onboarding is already shipped in code (encryption + App creds
in the DB, master-password unlock, secret-paste UI, project-settings/Doppler —
merged), but the **deployment has not switched to it**.

The migration goal (#289) is a **self-service deployable product**. The operator's
overriding priority is **ease**: deploy with as few moving parts as possible (not
a zoo of images), and start work on a new project by **just naming the repo** —
no per-repo dev-container configuration.

**Validated feasibility (2026-07-01):** Verity already spawns project containers
from the **standard base image directly** — the original Verity-provisioned
sample application container ran `ghcr.io/example-org/dev-base:latest` (labelled
`verity.project-id`); the product default is now
`ghcr.io/heey-global/verity/verity-sandbox:1.10.1`. `ProvisionerImpl` **runs,
never builds** (`resolveImage() = imageRef ?? default` →
`createContainer({ image })`; no `docker build`, no per-project Dockerfile). So
"point Verity at a repo → it clones + runs the standard container → agent works"
is real today, not aspirational. This ADR packages that into a product.

This ADR sits under the north-star of [ADR 0002](0002-credential-and-isolation-architecture.md)
(Runner/Server layering, DB-as-truth, credential broker) and depends on the
image-build/rollout migration in #299.

## Principles

1. **Minimal images.** The whole system is **two** images with clear roles —
   nothing per-project.
2. **One-command deploy.** A single `docker run` (or a tiny reference compose)
   brings Verity up; everything else is configured **in the app**.
3. **Repo-only project setup.** Adding a project is naming a repo; no
   dev-container config in the repo is required.

## Decisions

### R1 — Two images, no per-project images

- **Verity runner image** (`ghcr.io/heey-global/verity/verity-server`): the
  product the user installs — the compiled control-plane server
  (`packages/server` → `dist`) + the served web UI, on a minimal Node base, with
  the Docker **CLI/API client** it needs to spawn containers. Published +
  digest-pinned + Renovate-tracked.
- **Verity base image** (the dev-base successor): the single **standard
  dev-container** every project runs in (node/python/claude/gh/git + the git
  credential helper + the `gh` auth wrapper). One variant; **no per-project
  Dockerfiles** by default.

Verity ghcr artifacts share the `heey-global/verity/*` namespace: `.../verity-server`
(this image) and `.../verity-sandbox-toolkit` (the devcontainer Feature, ADR 0004) are
on it now. The **base image is mid-migration** (#475): verity-sandbox.yml now
DUAL-publishes it to both the legacy `ghcr.io/heey-global/verity-sandbox` (a sibling
path, no collision) and the new `ghcr.io/heey-global/verity/verity-sandbox` — same
digest under both. The legacy path stays live (the provisioner default + running
containers still resolve it) until the default flips to the new path and containers are
re-provisioned, then it's retired. NB the bare
`ghcr.io/heey-global/verity` (no trailing segment) is NOT free: `devcontainers/action`
parks the Features **collection-metadata** artifact there when publishing under the
`heey-global/verity` namespace. So the runner image must carry the `verity-server`
segment — the bare path is the collection index, not an image tag.

A project may **opt into** customization by including a **devcontainer** in the
repo (see R3.1); absent that, the default is the standard base — zero
project-side setup.

### R2 — One-command deploy; Docker access via a mounted socket by default

The reference install is a single container:

```
docker run -d \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v verity-data:/data \
  -p 8082:8082 \
  ghcr.io/heey-global/verity/verity-server
```

- **Docker access = mounted host socket** (simplest; one image, one command).
  This is the common self-hosted pattern (Portainer, Watchtower, …). **Trade-off,
  stated honestly:** a container with the host socket can do anything to the host
  Docker — it is effectively host-root-equivalent. Acceptable for a
  single-operator self-hosted control-plane; the operator owns the trust.
- **Hardening = opt-in socket-proxy sidecar.** A reference `docker-compose.yml`
  wires `tecnativa/docker-socket-proxy` (scoped API surface) + Verity, for
  operators who want the boundary. `VERITY_DOCKER_BASE_URL` already selects the
  proxy; the default (no proxy) selects the mounted socket.

*Implementation note:* the `DockerClient` today only exercises the proxy HTTP
URL; the `unix://` socket path exists but is untested. Making the mounted-socket
path first-class + tested is part of Phase A.

### R3 — Repo-only project setup

Adding a project is: **name the repo in the app** → Verity clones it into the
runner-owned workspace, runs a container from the standard base image with the
clone bind-mounted, mints a scoped token, and the agent is ready. No
`.dev-server/` scaffolding, no per-project build, no `dev add`. This already
works in the provisioner (R-context) — the product exposes it as a one-step app
flow.

### R3.1 — Per-project extra tools via devcontainer (opt-in, Verity-built + cached)

The standard base covers common tooling. A project that needs more declares it
the **standard way**: a **`.devcontainer/`** in the repo (the VS Code /
Codespaces spec — many repos already have one, and it is tool-interoperable). If
present, Verity builds the project's container **from it**; if absent, it runs
the standard base directly (the zero-config default of R3). No hand-published
images — **you declare, Verity builds.**

Mechanics — a `resolve-or-build` step runs before `createContainer`:

- Verity content-hashes `(devcontainer config + referenced Dockerfile/files +
  the pinned base image digest)` → a derived image tag
  `verity-proj-<owner>-<repo>:<hash>`.
- **Cache-keyed by that hash:** tag already on the daemon → run it (no rebuild);
  missing → build it, tag it, run it. `projects.image_ref` points at the derived
  tag.
- **Automatic invalidation:** editing the devcontainer OR a base-image rollout
  (#299, the base digest is in the hash) changes the hash → rebuild on the new
  base at the next provision; unchanged → always a cache hit. Docker layer cache
  keeps rebuilds cheap.
- **Build with the official `@devcontainers/cli`** (`devcontainer build`), not a
  home-grown parser — full-spec support (features, lifecycle) for free; Verity
  only tags + caches the result. `DockerClient` gains a build path (the
  socket-proxy already permits `BUILD`, so no proxy change).
- **Scope:** Phase 1 supports the `image` / `build.dockerfile` case (the
  "extra tools" need); `forwardPorts` maps to the dev-server port; `features` /
  `postCreateCommand` follow; VS-Code-only `customizations` are ignored.
- **Failure surface:** a build error puts the project in `state=failed` with the
  build log in `provision_error` (visible in the app); fix the devcontainer +
  re-provision.

Net: the default stays trivial (no devcontainer → base image), while
customization is a **standard, versioned, cached opt-in** — write a devcontainer,
Verity does the build.

### R4 — DB: embedded pglite on a named volume (external Postgres opt-in)

- **Default:** embedded pglite, persisted on a **dedicated named volume**
  (`verity-data:/data`) — zero external dependency, survives restarts. This
  **decouples the DB from any project bind-mount** (today it lives in
  `/work/.verity-data`, coupled to the verity checkout — wrong for a product).
- **Scale-up (opt-in):** external Postgres via `DATABASE_URL`.
- Migrations run automatically on every start (`migrateToLatest`).

### R5 — App-driven secrets (no host-mounted secret files)

The runner mounts **no** `.pem` / SSH keys. On first run the operator, in the
app: sets a **master password** (derives the at-rest key — ADR 0002 D3 /
`/secret/init`), then enters the **GitHub App credentials** + signing key →
encrypted DB. The master password is the **only** unlock path — the earlier
`VERITY_SECRET_KEY` env-key/headless auto-unlock has been removed (security review
H3), so on every restart the store comes up sealed and is unlocked from the app.
The code is shipped; this decision is the **deployment switch** away from
host-file secrets.

### R6 — Verity owns base-image pull, pin, and rollout

`createContainer` fails `ImageNotFound` if the base image isn't on the daemon —
Verity does not pull today (the cause of the 2026-07-01 stale-image incident,
where running containers never picked up a fixed image). The runner must:

- **Pull the pinned base image** on install/first-provision (a setup step or a
  `POST /setup/pull-base-image`), not rely on a host converge;
- **Pin** the base image (tag + digest) via `projects.image_ref` / a Verity
  default, Renovate-tracked;
- **Roll out** new base images deliberately: new sessions get the new image
  automatically; long-running sessions get a **visible, guarded recreate** (see
  #301 — recreate must warn/protect live sessions).

Full detail in #299 (base-image-build migration + rollout ownership).

### R7 — Runner-owned workspace/clone-root volume

The runner owns a **clone-root volume** (its `VERITY_HOST_CLONE_ROOT`) instead of
the shared `/data/dev`. Project clones live there and are bind-mounted into
spawned containers. This removes the dev-server host coupling.

## Rollout phases

- **Phase A — package + decouple** (R1/R2/R4/R7): standalone runner Dockerfile +
  reference compose; DB + clone-root on dedicated volumes; mounted-socket Docker
  access made first-class. Verity behaves as today, just cleanly packaged.
- **Phase B — flip to app secrets** (R5): stop mounting host secret files;
  onboard creds via the app.
- **Phase C — base-image ownership** (R6 / #299): Verity pulls/pins/rolls out the
  base image; retire the dev-server `dev-base.yml` build.
- **Phase D — parity + decommission** (#289 step 6): verify a fresh install
  reaches a working agent end-to-end; shut down the old dev-server Concierge +
  `dev` CLI.

## Consequences

- **Deploy shrinks to one image + one command**, with the DB and workspace on
  dedicated volumes and all credentials configured in the app — the core of "easy
  to deploy."
- **New project = name a repo**; no per-repo config — the core of "start work
  fast."
- The **mounted-socket default** is the one deliberate security trade-off,
  mitigated by the opt-in proxy sidecar.
- Relates: #289 (migration umbrella), #299 (base-image build + rollout), #301
  (recreate must protect live sessions), ADR 0002 (credential/isolation
  north-star).
