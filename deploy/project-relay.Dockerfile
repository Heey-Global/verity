# Fixed-destination per-project relay. The final image is distroless:
# no shell, package manager, diagnostics, credentials, or configurable upstream.

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
COPY packages/mobile/package.json packages/mobile/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --ignore-scripts --workspace=@verity/project-relay --include-workspace-root
COPY packages/project-relay packages/project-relay
RUN npx tsc -b packages/project-relay

# Shell-less runtime, pinned to the exact multi-architecture manifest.
# renovate: datasource=docker depName=gcr.io/distroless/nodejs24-debian13
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79

WORKDIR /app
COPY --from=builder --chown=65532:65532 /app/packages/project-relay/dist ./dist

USER 65532:65532
EXPOSE 8080 8443
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/main.js"]
