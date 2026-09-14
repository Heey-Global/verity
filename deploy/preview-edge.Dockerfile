# renovate: datasource=docker depName=node
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/preview-tunnel/package.json packages/preview-tunnel/tsconfig.json ./packages/preview-tunnel/
COPY packages/preview-tunnel/src ./packages/preview-tunnel/src
RUN npm ci --ignore-scripts
RUN npm run build --workspace @verity/preview-tunnel

# renovate: datasource=docker depName=node
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/packages/preview-tunnel/package.json ./package.json
COPY --from=build /src/packages/preview-tunnel/dist ./dist
COPY --from=build /src/node_modules/ws ./node_modules/ws
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["node", "dist/edge-main.js"]
