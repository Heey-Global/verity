ARG RUNSC_SOURCE_IMAGE
FROM ${RUNSC_SOURCE_IMAGE}
RUN apk add --no-cache python3 nftables so:libnftables.so.1 ip6tables conntrack-tools nodejs iproute2 util-linux clang llvm linux-headers bpftool
RUN python3 -c "import ctypes, os; lib=ctypes.CDLL('libnftables.so.1'); assert hasattr(lib, 'nft_ctx_buffer_output') and hasattr(os, 'setns')"
COPY deploy/egress/project-egress-deadline.bpf.c deploy/egress/project-egress-deadline.py deploy/egress/project-egress-renew.bpf.c /opt/verity-egress/
RUN clang -O2 -g -target bpf -c /opt/verity-egress/project-egress-deadline.bpf.c -o /opt/verity-egress/project-egress-deadline.bpf.o
RUN clang -O2 -g -target bpf -c /opt/verity-egress/project-egress-renew.bpf.c -o /opt/verity-egress/project-egress-renew.bpf.o
# Only this disposable egress daemon knows the experimental relay profile.
RUN node -e 'const fs=require("fs");const p="/etc/docker/daemon.json";const c=JSON.parse(fs.readFileSync(p));c.runtimes["runsc-relay"]={path:c.runtimes["runsc-project"].path,runtimeArgs:["--platform=systrap","--network=sandbox","--host-uds=open"]};c.runtimes["runsc-relay-debug"]={path:c.runtimes["runsc-relay"].path,runtimeArgs:[...c.runtimes["runsc-relay"].runtimeArgs,"--debug","--debug-log=/evidence/runsc-debug/","--panic-log=/evidence/runsc-panic/"]};fs.writeFileSync(p,JSON.stringify(c));'
RUN ln -sf /usr/local/bin/docker /usr/bin/docker
COPY scripts/probes/project-egress /probe
COPY deploy/gvisor/versions.env /probe/runtime-pins.env
ENTRYPOINT ["/bin/sh", "/probe/host-entrypoint.sh"]
