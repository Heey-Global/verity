ARG RUNSC_SOURCE_IMAGE
FROM ${RUNSC_SOURCE_IMAGE} AS runtime

# renovate: datasource=docker depName=moby/buildkit
FROM moby/buildkit:v0.23.2@sha256:ddd1ca44b21eda906e81ab14a3d467fa6c39cd73b9a39df1196210edcb8db59e
COPY --from=runtime /opt/verity/runsc /opt/verity/runsc
COPY deploy/gvisor/versions.env /tmp/versions.env
RUN set -eu; \
    release="$(sed -n 's/^RUNSC_RELEASE=//p' /tmp/versions.env)"; \
    ln -s "/opt/verity/runsc/$release/runsc" /usr/local/bin/runsc-real; \
    /usr/local/bin/runsc-real --version; \
    rm /tmp/versions.env; \
    mkdir -p /evidence/bundles /evidence/runsc
COPY scripts/probes/devcontainer-gvisor/runsc-probe.sh /usr/local/bin/runsc
COPY scripts/probes/devcontainer-gvisor/buildkitd.toml /etc/buildkit/buildkitd.toml
RUN chmod 0755 /usr/local/bin/runsc
