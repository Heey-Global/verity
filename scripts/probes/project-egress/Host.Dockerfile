ARG RUNSC_SOURCE_IMAGE
FROM ${RUNSC_SOURCE_IMAGE}
RUN apk add --no-cache python3 nftables ip6tables conntrack-tools nodejs
RUN ln -sf /usr/local/bin/docker /usr/bin/docker
COPY scripts/probes/project-egress /probe
COPY deploy/gvisor/versions.env /probe/runtime-pins.env
ENTRYPOINT ["/bin/sh", "/probe/host-entrypoint.sh"]
