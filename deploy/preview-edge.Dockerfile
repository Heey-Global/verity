# renovate: datasource=docker depName=node
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/preview-tunnel/package.json packages/preview-tunnel/tsconfig.json ./packages/preview-tunnel/
COPY packages/preview-tunnel/src ./packages/preview-tunnel/src
RUN npm ci --ignore-scripts
RUN npm run build --workspace @verity/preview-tunnel

# renovate: datasource=docker depName=node
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/packages/preview-tunnel/package.json ./package.json
COPY --from=build /src/packages/preview-tunnel/dist ./dist
COPY --from=build /src/node_modules/ws ./node_modules/ws
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["node", "dist/edge-main.js"]
