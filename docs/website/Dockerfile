# renovate: datasource=docker depName=nginxinc/nginx-unprivileged
FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6

LABEL org.opencontainers.image.source="https://github.com/Heey-Global/verity"
LABEL org.opencontainers.image.description="Verity product website"

COPY --chown=101:101 docs/website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 docs/website/site/index.html /usr/share/nginx/html/index.html
COPY --chown=101:101 docs/website/site/install.sh /usr/share/nginx/html/install.sh
COPY --chown=101:101 docs/website/site/assets/hero-product-verity-v5.png /usr/share/nginx/html/assets/hero-product-verity-v5.png
COPY --chown=101:101 docs/website/site/assets/verity-mark.png /usr/share/nginx/html/assets/verity-mark.png
COPY --chown=101:101 docs/website/site/assets/verity-favicon.png /usr/share/nginx/html/assets/verity-favicon.png
# Self-host Inter and distribute its SIL OFL licence with it.
COPY --chown=101:101 docs/website/site/assets/inter-latin-variable.woff2 /usr/share/nginx/html/assets/inter-latin-variable.woff2
COPY --chown=101:101 docs/website/site/assets/inter-LICENSE.txt /usr/share/nginx/html/assets/inter-LICENSE.txt

USER 101:101
EXPOSE 8080
