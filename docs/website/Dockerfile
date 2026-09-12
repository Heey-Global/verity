# renovate: datasource=docker depName=nginxinc/nginx-unprivileged
FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6

ARG REQUIRE_APPLE_ASSOCIATION=false

LABEL org.opencontainers.image.source="https://github.com/Heey-Global/verity"
LABEL org.opencontainers.image.description="Verity product website"

COPY --chown=101:101 docs/website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 docs/website/site/index.html /usr/share/nginx/html/index.html
COPY --chown=101:101 docs/website/site/install.sh /usr/share/nginx/html/install.sh
COPY --chown=101:101 docs/website/site/github-app.html /usr/share/nginx/html/github/app/index.html
COPY --chown=101:101 docs/website/site/github-app.js /usr/share/nginx/html/github/app/github-app.js
COPY --chown=101:101 docs/website/site/github-callback.html /usr/share/nginx/html/github/app/callback.html
COPY --chown=101:101 docs/website/site/mcp-oauth-callback.html /usr/share/nginx/html/mcp/oauth/callback.html
COPY --chown=101:101 docs/website/site/apple-app-site-association.json /tmp/apple-app-site-association.json
USER root
RUN --mount=type=secret,id=apple_team_id,required=false \
    APPLE_TEAM_ID="$(cat /run/secrets/apple_team_id 2>/dev/null || printf TEAMID0000)" \
    && case "$APPLE_TEAM_ID" in (??????????) :;; (*) exit 1;; esac \
    && case "$APPLE_TEAM_ID" in (*[!A-Z0-9]*) exit 1;; esac \
    && if [ "$REQUIRE_APPLE_ASSOCIATION" = true ] && [ "$APPLE_TEAM_ID" = TEAMID0000 ]; then exit 1; fi \
    && mkdir -p /usr/share/nginx/html/.well-known \
    && sed "s/__APPLE_TEAM_ID__/$APPLE_TEAM_ID/g" /tmp/apple-app-site-association.json \
      > /usr/share/nginx/html/.well-known/apple-app-site-association \
    && rm /tmp/apple-app-site-association.json
USER 101:101
COPY --chown=101:101 docs/website/site/assets/hero-product-verity-v5.png /usr/share/nginx/html/assets/hero-product-verity-v5.png
COPY --chown=101:101 docs/website/site/assets/verity-mark.png /usr/share/nginx/html/assets/verity-mark.png
COPY --chown=101:101 docs/website/site/assets/verity-favicon.png /usr/share/nginx/html/assets/verity-favicon.png
# Self-host Inter and distribute its SIL OFL licence with it.
COPY --chown=101:101 docs/website/site/assets/inter-latin-variable.woff2 /usr/share/nginx/html/assets/inter-latin-variable.woff2
COPY --chown=101:101 docs/website/site/assets/inter-LICENSE.txt /usr/share/nginx/html/assets/inter-LICENSE.txt

USER 101:101
EXPOSE 8080
