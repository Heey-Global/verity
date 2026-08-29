# renovate: datasource=docker depName=node
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/preview-tunnel/package.json packages/preview-tunnel/tsconfig.json ./packages/preview-tunnel/
COPY packages/preview-tunnel/src ./packages/preview-tunnel/src
RUN npm ci --ignore-scripts
RUN npm run build --workspace @verity/preview-tunnel

# renovate: datasource=docker depName=node
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/packages/preview-tunnel/package.json ./package.json
COPY --from=build /src/packages/preview-tunnel/dist ./dist
COPY --from=build /src/packages/preview-tunnel/node_modules/ws ./node_modules/ws
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["node", "dist/edge-main.js"]
