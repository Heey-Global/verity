# Base image for one-job Brokered Secrets pilots. Derived pilot images add exactly one immutable
# adapter at /usr/local/bin/verity-secret-job-pilot; the server pins the resulting image by digest.

# renovate: datasource=docker depName=node
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
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
RUN npm ci --ignore-scripts
COPY packages/events packages/events
COPY packages/secret-contracts packages/secret-contracts
COPY packages/adapter-claude packages/adapter-claude
COPY packages/project-relay packages/project-relay
COPY packages/store packages/store
COPY packages/session packages/session
COPY packages/server packages/server
COPY packages/preview-tunnel packages/preview-tunnel
COPY features features
RUN npm run build

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
RUN npm ci --omit=dev --ignore-scripts --workspace=@verity/server --include-workspace-root

# Shell-less, non-root runtime. No network tools, package manager, writable worktree, or credentials.
# renovate: datasource=docker depName=gcr.io/distroless/nodejs24-debian13
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79 AS worker-base
WORKDIR /app
COPY --from=deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/packages/secret-contracts/dist ./packages/secret-contracts/dist
COPY --from=builder --chown=65532:65532 /app/packages/secret-contracts/package.json ./packages/secret-contracts/package.json
COPY --from=builder --chown=65532:65532 /app/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=65532:65532 /app/packages/server/package.json ./packages/server/package.json
COPY --chown=65532:65532 --chmod=0555 deploy/bin/verity-secret-job-worker /usr/local/bin/verity-secret-job-worker
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/verity-secret-job-worker"]

# CI-only derived pilot. The default final stage below remains the pilot-free release image.
FROM worker-base AS fake-pilot
COPY --chown=65532:65532 --chmod=0555 deploy/bin/verity-secret-job-fake-pilot /usr/local/bin/verity-secret-job-pilot

FROM worker-base AS release
