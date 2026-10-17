# Fixed-destination per-project relay. The final image is distroless:
# no shell, package manager, diagnostics, credentials, or configurable upstream.

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
COPY packages/mobile/package.json packages/mobile/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --ignore-scripts --workspace=@verity/project-relay --include-workspace-root
COPY packages/project-relay packages/project-relay
RUN npx tsc -b packages/project-relay

# Shell-less runtime, pinned to the exact multi-architecture manifest.
# renovate: datasource=docker depName=gcr.io/distroless/nodejs26-debian13
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:044d090d0c3ccfd30722126ebe46704885698970c8a303419dc0d704d628f0da

# Use the builder's exact Node patch; the distroless base may lag a patch release.
COPY --from=builder /usr/local/bin/node /nodejs/bin/node
WORKDIR /app
COPY --from=builder --chown=65532:65532 /app/packages/project-relay/dist ./dist

USER 65532:65532
EXPOSE 8080 8443
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/main.js"]
