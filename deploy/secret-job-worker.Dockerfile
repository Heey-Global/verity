# Base image for one-job Brokered Secrets pilots. Derived pilot images add exactly one immutable
# adapter at /usr/local/bin/verity-secret-job-pilot; the server pins the resulting image by digest.

# renovate: datasource=docker depName=node
FROM node:26.12.0-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913 AS builder
WORKDIR /app
COPY vendor/expo-router-query-string ./vendor/expo-router-query-string
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
FROM node:26.12.0-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913 AS deps
WORKDIR /app
COPY vendor/expo-router-query-string ./vendor/expo-router-query-string
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
# renovate: datasource=docker depName=gcr.io/distroless/nodejs26-debian13
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:044d090d0c3ccfd30722126ebe46704885698970c8a303419dc0d704d628f0da AS worker-base
# Use the builder's exact Node patch; the distroless base may lag a patch release.
COPY --from=builder /usr/local/bin/node /nodejs/bin/node
WORKDIR /app
COPY --from=deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=deps --chown=65532:65532 /app/packages ./packages
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
