ARG RUNSC_SOURCE_IMAGE
FROM ${RUNSC_SOURCE_IMAGE} AS runtime

# renovate: datasource=docker depName=moby/buildkit
FROM moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe
COPY --from=runtime /opt/verity/runsc /opt/verity/runsc
COPY deploy/gvisor/versions.env /tmp/versions.env
RUN set -eu; \
    release="$(sed -n 's/^RUNSC_RELEASE=//p' /tmp/versions.env)"; \
    ln -s "/opt/verity/runsc/$release/runsc" /usr/local/bin/runsc-real; \
    /usr/local/bin/runsc-real --version; \
    rm /tmp/versions.env; \
    mkdir -p /evidence/bundles /evidence/runsc
COPY scripts/probes/devcontainer-gvisor/runsc-probe.sh /usr/local/bin/runsc
COPY scripts/probes/devcontainer-gvisor/runsc-buildkit-args.sh /usr/local/bin/runsc-buildkit-args
COPY scripts/probes/devcontainer-gvisor/buildkitd.toml /etc/buildkit/buildkitd.toml
RUN chmod 0755 /usr/local/bin/runsc /usr/local/bin/runsc-buildkit-args
