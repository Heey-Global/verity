ARG RUNSC_SOURCE_IMAGE
FROM ${RUNSC_SOURCE_IMAGE}
RUN apk add --no-cache python3 nftables ip6tables conntrack-tools nodejs
# Only this disposable egress daemon knows the experimental relay profile.
RUN node -e 'const fs=require("fs");const p="/etc/docker/daemon.json";const c=JSON.parse(fs.readFileSync(p));c.runtimes["runsc-relay"]={path:c.runtimes["runsc-project"].path,runtimeArgs:["--platform=systrap","--network=sandbox","--host-uds=open"]};fs.writeFileSync(p,JSON.stringify(c));'
RUN ln -sf /usr/local/bin/docker /usr/bin/docker
COPY scripts/probes/project-egress /probe
COPY deploy/gvisor/versions.env /probe/runtime-pins.env
ENTRYPOINT ["/bin/sh", "/probe/host-entrypoint.sh"]
