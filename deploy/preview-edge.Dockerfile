# renovate: datasource=docker depName=node
FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS build
WORKDIR /src
COPY vendor/expo-router-query-string ./vendor/expo-router-query-string
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/preview-tunnel/package.json packages/preview-tunnel/tsconfig.json ./packages/preview-tunnel/
COPY packages/preview-tunnel/src ./packages/preview-tunnel/src
RUN npm ci --ignore-scripts
RUN npm run build --workspace @verity/preview-tunnel

# renovate: datasource=docker depName=node
FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/packages/preview-tunnel/package.json ./package.json
COPY --from=build /src/packages/preview-tunnel/dist ./dist
COPY --from=build /src/node_modules/ws ./node_modules/ws
COPY packages/preview-tunnel/assets/verity-mark.png ./assets/verity-mark.png
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["node", "dist/edge-main.js"]
