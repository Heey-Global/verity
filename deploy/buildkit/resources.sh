#!/usr/bin/env bash
# Prints the builder's systemd resource limits for this host as KEY=VALUE lines.
# Half the CPUs (at least one) and a quarter of the memory, kept between 2 GiB
# and 8 GiB: enough for package installs under gVisor, which charges the
# sandbox kernel's memory to this unit, while leaving the rest of the host to
# the Server and the project sandboxes it runs.
set -euo pipefail
cpus=${VERITY_BUILDKIT_HOST_CPUS:-$(nproc)}
mem_kib=${VERITY_BUILDKIT_HOST_MEM_KIB:-$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)}
[[ $cpus =~ ^[1-9][0-9]*$ && $mem_kib =~ ^[1-9][0-9]*$ ]] || { echo 'Cannot read host CPU and memory size' >&2; exit 1; }
cores=$((cpus / 2))
((cores >= 1)) || cores=1
mem_mib=$((mem_kib / 1024 / 4))
((mem_mib >= 2048)) || mem_mib=2048
((mem_mib <= 8192)) || mem_mib=8192
printf 'CPU_QUOTA=%s%%\nMEMORY_MAX=%sM\n' "$((cores * 100))" "$mem_mib"
