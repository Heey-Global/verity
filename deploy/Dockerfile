# Verity Server image — the standalone control-plane an operator installs to run
# Verity on any host (ADR 0003, Phase A). API-only: the compiled Fastify server
# (packages/server -> dist) on a minimal Node 24 base, plus the `docker` CLI and
# `git` the runtime needs to clone repos and spawn sibling project containers.
# The Expo mobile app is the client; no web build ships here.
#
# Multi-stage:
#   builder    -> npm ci (whole monorepo) + tsc -b  => packages/*/dist
#   deps       -> npm ci --omit=dev scoped to @verity/server => pruned node_modules
#   docker-cli -> fetch the pinned static docker client + buildx/compose plugins
#   runtime    -> slim node + git + docker CLI/plugins, non-root, dist + prod node_modules
#
# All base images are tag+digest pinned with Renovate annotations per the repo's
# dependency rule; the docker CLI is pinned to an exact release.

# ---------------------------------------------------------------------------
# Stage 1: builder — compile the TypeScript monorepo.
# ---------------------------------------------------------------------------
# renovate: datasource=docker depName=node
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS builder

WORKDIR /app

# Copy the manifests first so the dependency layer caches independently of source
# churn. The lockfile + every workspace package.json are needed for `npm ci`.
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/events/package.json packages/events/
COPY packages/secret-contracts/package.json packages/secret-contracts/
COPY packages/adapter-claude/package.json packages/adapter-claude/
COPY packages/project-relay/package.json packages/project-relay/
COPY packages/store/package.json packages/store/
COPY packages/session/package.json packages/session/
COPY packages/server/package.json packages/server/
COPY packages/preview-tunnel/package.json packages/preview-tunnel/
COPY packages/mobile/package.json packages/mobile/
COPY apps/mobile/package.json apps/mobile/

# Full install (incl. dev deps: typescript, etc.) so `tsc -b` can compile.
# --ignore-scripts (audit M1): do NOT run dependency lifecycle scripts during the
# control-plane image build — the component whose job is to contain npm supply-chain
# attacks must not itself execute an arbitrary transitive `postinstall` as root at
# build time. The server's deps (fastify, zod, ws, pglite, kysely) are pure JS/wasm
# and need no build step; `tsc -b` compiles from source below.
RUN npm ci --ignore-scripts

# Only the server-reachable packages need compiling; the mobile app is not built
# in the Server image. tsconfig.json references build the server's dep graph
# (events, secret-contracts, adapter-claude, store, session, server) via project references.
COPY packages/events packages/events
COPY packages/secret-contracts packages/secret-contracts
COPY packages/adapter-claude packages/adapter-claude
COPY packages/project-relay packages/project-relay
COPY packages/store packages/store
COPY packages/session packages/session
COPY packages/server packages/server
COPY packages/preview-tunnel packages/preview-tunnel

# The sandbox-toolkit feature lives at the repo root, outside the workspaces.
# It ships no runtime import into the server, but a server test type-checks its
# `bin/*.d.mts` declarations via a relative `../../../features/...` path, and
# `tsc -b` compiles test files. Without this the builder's `npm run build` fails
# with TS2307 (module not found) even though the image never runs the toolkit.
COPY features features

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: deps — production-only node_modules, scoped to the server workspace.
# ---------------------------------------------------------------------------
# A whole-monorepo `--omit=dev` would still hoist apps/mobile's runtime deps
# (Expo / React Native, hundreds of MB) into the root node_modules. Scoping the
# install to @verity/server resolves only the server's transitive tree, so the
# runtime image stays lean. --include-workspace-root keeps root-level runtime
# deps (there are none today, but it is correct if any are added).
# renovate: datasource=docker depName=node
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/events/package.json packages/events/
COPY packages/secret-contracts/package.json packages/secret-contracts/
COPY packages/adapter-claude/package.json packages/adapter-claude/
COPY packages/project-relay/package.json packages/project-relay/
COPY packages/store/package.json packages/store/
COPY packages/session/package.json packages/session/
COPY packages/server/package.json packages/server/
COPY packages/preview-tunnel/package.json packages/preview-tunnel/
COPY packages/mobile/package.json packages/mobile/
COPY apps/mobile/package.json apps/mobile/

# --ignore-scripts (audit M1): the pruned runtime deps carry no build step either;
# never execute a dependency postinstall as root while assembling the image.
RUN npm ci --omit=dev --ignore-scripts --workspace=@verity/server --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 3: docker-cli — fetch the pinned static docker client + CLI plugins.
# ---------------------------------------------------------------------------
# The runtime spawns sibling containers by exec'ing the `docker` CLI against the
# mounted host socket (VERITY_DOCKER_BASE_URL=unix:///var/run/docker.sock). Only
# the client binary from the static bundle and the buildx/compose CLI plugins
# are needed — not dockerd/containerd.
# renovate: datasource=docker depName=node
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS docker-cli

# The static CLI download version tracks Docker Engine (moby) releases, whose
# GitHub tags are `docker-v<x.y.z>` — the extractVersion strips that prefix and
# (by not matching) filters out the repo's `client/` and `api/` tags.
# renovate: datasource=github-releases depName=moby/moby extractVersion=^docker-v(?<version>.*)$
ARG DOCKER_CLI_VERSION=29.6.1
# Published SHA256 of docker-${DOCKER_CLI_VERSION}.tgz (linux x86_64 static
# stable). Verified at author time; bump alongside DOCKER_CLI_VERSION.
ARG DOCKER_CLI_SHA256=b0df4a43a98d7ecb708acbdb5a34a3416e13b6e39bcbbdf296f51f0f3442b29f
# renovate: datasource=github-releases depName=docker/buildx
ARG DOCKER_BUILDX_VERSION=0.35.0
# Published release digest of buildx-v${DOCKER_BUILDX_VERSION}.linux-amd64.
# Verified at author time; bump alongside DOCKER_BUILDX_VERSION.
ARG DOCKER_BUILDX_SHA256=d41ece72044243b4f58b343441ae37446d9c29a7d6b5e11c61847bbcf8f7dfda
# renovate: datasource=github-releases depName=docker/compose
ARG DOCKER_COMPOSE_VERSION=2.40.3
# Published release digest of docker-compose-linux-x86_64.
# Verified at author time; bump alongside DOCKER_COMPOSE_VERSION.
ARG DOCKER_COMPOSE_SHA256=dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372

# `--retry-all-errors` rather than `--retry-connrefused`: plain `--retry` covers
# timeouts, 5xx and (with that flag) a refused connection, and none of those is what
# breaks here. A connection dropped mid-transfer exits 56, which curl treats as final
# — "Connection died, tried 5 times before giving up" is its internal connection
# reuse retry, and all five attempts are spent inside a second. That killed the
# self-update job's build twice in a row on the ~60 MB compose binary, downloaded
# from inside a nested daemon. `--retry-all-errors` is what puts exit 56 under the
# `--retry-delay` budget. Every artifact below is checked against a pinned digest, so
# a retry that returns something else fails the build rather than shipping it.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
      -o /tmp/docker.tgz \
      "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz"; \
    echo "${DOCKER_CLI_SHA256}  /tmp/docker.tgz" | sha256sum -c -; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
      -o /tmp/docker-buildx \
      "https://github.com/docker/buildx/releases/download/v${DOCKER_BUILDX_VERSION}/buildx-v${DOCKER_BUILDX_VERSION}.linux-amd64"; \
    echo "${DOCKER_BUILDX_SHA256}  /tmp/docker-buildx" | sha256sum -c -; \
    install -m 0755 /tmp/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx; \
    curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
      -o /tmp/docker-compose \
      "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64"; \
    echo "${DOCKER_COMPOSE_SHA256}  /tmp/docker-compose" | sha256sum -c -; \
    install -m 0755 /tmp/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose; \
    ln -s /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose; \
    rm -rf /tmp/docker.tgz /tmp/docker; \
    rm -f /tmp/docker-buildx /tmp/docker-compose; \
    docker --version; \
    docker buildx version; \
    docker compose version; \
    docker-compose version

# ---------------------------------------------------------------------------
# Stage 4: runtime — the shipped image.
# ---------------------------------------------------------------------------
# renovate: datasource=docker depName=node
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime

# git: the provisioner clones project repos on the Server.
# ca-certificates: TLS to github.com and Docker registries.
# tini: proper PID 1 signal handling / zombie reaping for the long-lived server.
# openssh-client: provides `ssh-keygen`, needed by POST /settings/signing-key/generate.
# openssl: generates short-lived mTLS material for gateway verification and tests.
# ffmpeg: windows and compresses meeting audio before uploading it to the
#   configured transcription backend.
# expect: drives interactive Claude auth through a real PTY for app login.
# util-linux: provides setpriv for the image's anti-forgery boundary test.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git ca-certificates tini openssh-client openssl ffmpeg expect util-linux; \
    rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/bin/docker-compose /usr/local/bin/docker-compose
COPY --from=docker-cli /usr/local/lib/docker/cli-plugins/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx
COPY --from=docker-cli /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
COPY deploy/bin/verity-transcribe-meeting /usr/local/bin/verity-transcribe-meeting

# Self-contained host bootstrap payload. The public installer copies this tree
# from the exact digest it is about to install, so Compose, overlays and guarded
# host scripts can never drift from the Server release.
COPY deploy /opt/verity-install/deploy
RUN chmod 0755 /usr/local/bin/verity-transcribe-meeting

# The official devcontainer CLI (ADR 0003 R3.1): when a project repo carries a
# `.devcontainer/`, the provisioner shells out `devcontainer build` to build a
# content-hash-cached derived image onto the mounted daemon. It drives the docker
# CLI + buildx plugin copied above via DOCKER_HOST. Installed BEFORE `USER node`
# so the global package lands in the image's root-owned prefix; pinned exactly.
# Keep each global CLI in its own annotated RUN instruction. Renovate's regex
# manager matches one dependency per instruction; combining these pins silently
# hides every package after the first one from dependency updates.
# renovate: datasource=npm depName=@devcontainers/cli
RUN npm install -g @devcontainers/cli@0.88.0
# renovate: datasource=npm depName=@anthropic-ai/claude-code
RUN npm install -g @anthropic-ai/claude-code@2.1.241
# renovate: datasource=npm depName=@agentclientprotocol/claude-agent-acp
RUN npm install -g @agentclientprotocol/claude-agent-acp@0.70.0
# Harden that install: upstream (through 0.66.0) builds tool-call titles out of
# unvalidated model input, so one wrong-typed field throws, ends the agent
# process, and — because loadSession replays history through the same renderer —
# leaves the session unresumable for good. The sandbox toolkit's install.sh runs
# the same script; it's copied on its own here so the pinned installs above keep
# their cache layers. It no-ops on a fixed upstream and FAILS THE BUILD if it can
# no longer be applied, because a silently unhardened adapter is
# indistinguishable from a hardened one until a session dies. See ADR 0012.
COPY features/verity-sandbox-toolkit/bin/verity-claude-acp-harden.mjs /tmp/verity-claude-acp-harden.mjs
RUN node /tmp/verity-claude-acp-harden.mjs && rm /tmp/verity-claude-acp-harden.mjs
COPY features/verity-sandbox-toolkit/bin/verity-claude-acp-lifecycle.mjs /tmp/verity-claude-acp-lifecycle.mjs
RUN node /tmp/verity-claude-acp-lifecycle.mjs && rm /tmp/verity-claude-acp-lifecycle.mjs
# renovate: datasource=npm depName=@openai/codex
RUN npm install -g @openai/codex@0.149.0
# renovate: datasource=npm depName=@agentclientprotocol/codex-acp
RUN npm install -g @agentclientprotocol/codex-acp@1.6.2

# Bundle the shared `verity-sandbox-toolkit` devcontainer Feature (R3.1/#299) so
# project devcontainer builds can inject it via `--additional-features`. The
# devcontainer CLI reads this local path at build time; it's own-layer +
# root-owned (copied before `USER node`).
COPY features/verity-sandbox-toolkit /opt/verity-features/verity-sandbox-toolkit

# The same immutable release image also runs the isolated control-plane Runner
# sidecar. Keep its root-owned launch surface identical to project Sandboxes;
# Compose selects it with an explicit entrypoint, while the Server still runs as
# the unprivileged `node` user below.
RUN install -m 0755 /opt/verity-features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs /usr/local/bin/verity-runner-supervisor \
    && install -m 0755 /opt/verity-features/verity-sandbox-toolkit/bin/verity-runner-supervisor-start /usr/local/bin/verity-runner-supervisor-start \
    && install -m 0755 /opt/verity-features/verity-sandbox-toolkit/bin/verity-runner-stack-start /usr/local/bin/verity-runner-stack-start \
    && install -m 0755 /opt/verity-features/verity-sandbox-toolkit/bin/verity-runner-worker.mjs /usr/local/bin/verity-runner-worker \
    && install -m 0755 /opt/verity-features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs /usr/local/bin/verity-agent-spawn-broker \
    && install -m 0755 /opt/verity-features/verity-sandbox-toolkit/bin/verity-egress-connector.mjs /usr/local/bin/verity-egress-connector \
    && install -m 0755 /opt/verity-features/verity-sandbox-toolkit/bin/verity-egress-connector-start /usr/local/bin/verity-egress-connector-start \
    && install -m 0755 /opt/verity-features/verity-sandbox-toolkit/bin/verity-agent-run /usr/local/bin/verity-agent-run
COPY deploy/bin/verity-control-plane-runner-start /usr/local/bin/verity-control-plane-runner-start
COPY deploy/bin/verity-control-plane-git-sign /usr/local/bin/verity-control-plane-git-sign
# The launcher calls this one and treats a non-zero exit as fatal, so an image
# that forgets it does not degrade quietly — it refuses to start the
# control-plane Runner. `verity-compose.test.ts` pins the pair for that reason.
COPY deploy/bin/verity-control-plane-docker-grant /usr/local/bin/verity-control-plane-docker-grant
RUN chmod 0755 /usr/local/bin/verity-control-plane-runner-start /usr/local/bin/verity-control-plane-git-sign /usr/local/bin/verity-control-plane-docker-grant

WORKDIR /app

# Pruned production node_modules (root-hoisted + per-workspace) and the compiled
# output. Ownership set to the non-root node user baked into the base image.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/events/dist ./packages/events/dist
COPY --from=builder --chown=node:node /app/packages/events/package.json ./packages/events/package.json
COPY --from=builder --chown=node:node /app/packages/secret-contracts/dist ./packages/secret-contracts/dist
COPY --from=builder --chown=node:node /app/packages/secret-contracts/package.json ./packages/secret-contracts/package.json
COPY --from=builder --chown=node:node /app/packages/adapter-claude/dist ./packages/adapter-claude/dist
COPY --from=builder --chown=node:node /app/packages/adapter-claude/package.json ./packages/adapter-claude/package.json
COPY --from=builder --chown=node:node /app/packages/store/dist ./packages/store/dist
COPY --from=builder --chown=node:node /app/packages/store/package.json ./packages/store/package.json
COPY --from=builder --chown=node:node /app/packages/session/dist ./packages/session/dist
COPY --from=builder --chown=node:node /app/packages/session/package.json ./packages/session/package.json
COPY --from=builder --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=node:node /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder --chown=node:node /app/package.json ./package.json

# The shared release version, injected by release.yml (semantic-release) as a
# build-arg, immutable file, and compatibility environment variable. The Server
# reads the file so a managed cutover cannot override the target image's identity
# with an environment value inherited from the outgoing generation.
# semantic-release does not commit the version back into package.json, so baking it
# in here (no git write-back) is the only shipped runtime source. PR/local builds
# omit the arg and fall back to the `-dev` sentinel.
ARG VERITY_SERVER_VERSION=0.0.0-dev
ENV VERITY_SERVER_VERSION=${VERITY_SERVER_VERSION}
RUN printf '%s\n' "$VERITY_SERVER_VERSION" > /app/.verity-server-version \
    && chown node:node /app/.verity-server-version \
    && chmod 0444 /app/.verity-server-version

# Optional, immutable promise used only by an explicitly reviewed bridge build.
# Empty means the Server advertises no generations beyond its in-code current
# migration. The release workflow never sets this for ordinary releases.
ARG VERITY_SCHEMA_FORWARD_MAX=
RUN if [ -n "$VERITY_SCHEMA_FORWARD_MAX" ]; then \
      printf '%s\n' "$VERITY_SCHEMA_FORWARD_MAX" > /app/.verity-schema-forward-max; \
      chown node:node /app/.verity-schema-forward-max; \
      chmod 0444 /app/.verity-schema-forward-max; \
    fi

# Official release builds inject the relay image produced by the same release
# workflow. Keeping the immutable reference in a separate baked variable lets the
# server use the release-matched relay without deploy-time wiring, while
# VERITY_PROJECT_RELAY_IMAGE remains an explicit override for custom topologies.
ARG VERITY_BUNDLED_PROJECT_RELAY_IMAGE=
ENV VERITY_BUNDLED_PROJECT_RELAY_IMAGE=${VERITY_BUNDLED_PROJECT_RELAY_IMAGE}

# The control-plane PostgreSQL pin this release was built against (ADR 0008 D14),
# taken by release.yml straight from `deploy/docker-compose.yml` — the same line
# Renovate bumps. Without it a bump reaches an installed host exactly once, at
# bootstrap, and the database then never gets a security update again.
#
# A LABEL and not an ENV, deliberately. `managed-server-owner.ts` explains why
# VERITY_BUNDLED_PROJECT_RELAY_IMAGE above is the ONLY environment value a
# managed Server is allowed to inherit from its image instead of from the sealed
# spec: a second exemption re-opens the spec/image disagreement that once stopped
# the Updater from starting its Server at all. The Updater reads this off the
# pulled target image and it never enters any container's environment, so it
# cannot participate in that comparison. Empty on PR/local builds, which the
# reader treats identically to a release that predates the label.
ARG VERITY_BUNDLED_POSTGRES_IMAGE=
LABEL org.verity.postgres-image=${VERITY_BUNDLED_POSTGRES_IMAGE}

# The Google Drive OAuth iOS client id (ADR 0009), injected by release.yml as a
# build-arg so the running server has it WITHOUT runtime Doppler access (the
# customer deployment cannot reach the vendor Doppler). Non-secret — the same id
# ships in the mobile app — so baking it into the image ENV is safe; the app reads
# it from /settings to build the PKCE request. A deploy-time `-e GOOGLE_AUTH_ID=…`
# overrides this default. Empty on PR/local builds, where the Drive feature simply
# reports "not configured".
ARG GOOGLE_AUTH_ID=
ENV GOOGLE_AUTH_ID=${GOOGLE_AUTH_ID}

# API port. PORT is read by the server (packages/server/src/main.ts). 8082 is the
# deployment default per ADR 0003 R2.
ENV NODE_ENV=production
ENV PORT=8082
EXPOSE 8082

# Data root (VERITY_ROOT). The control-plane DB is an external PostgreSQL
# (DATABASE_URL, set by docker-compose.yml); everything Verity writes to disk lives
# under /srv/verity, backed by the named `verity-data` volume. Pre-create it owned
# by the non-root `node` user (uid 1000) so Docker initializes the empty volume with
# that ownership on first mount — the server can then clone + materialize without any
# operator-side `mkdir`/`chown` on the host (security review M16).
ENV VERITY_ROOT=/srv/verity
RUN mkdir -p /srv/verity /run/verity-agent-gateway /var/lib/verity-agent-gateway \
      /run/verity-gateway \
    && chown node:node /srv/verity /run/verity-agent-gateway /var/lib/verity-agent-gateway \
      /run/verity-gateway

# Run unprivileged. Access to the mounted docker socket is granted by the
# compose file's group_add, not by running as root.
USER node

# tini as PID 1 forwards SIGTERM/SIGINT to node for the graceful shutdown path.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "packages/server/dist/main.js"]
