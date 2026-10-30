#!/bin/sh
set -eu
# Each disposable daemon owns its software BPF pins; no production mount is changed.
if ! mountpoint -q /sys/fs/bpf; then
  mount -t bpf bpf /sys/fs/bpf
fi
# Every daemon boot restores an empty fence before restart-policy containers can run.
python3 - <<'PY'
import subprocess
import sys
sys.path.insert(0, '/probe')
from policy import nft, base_rules
existing = subprocess.run(['nft', 'list', 'table', 'inet', 'project_egress'], capture_output=True)
prefix = 'delete table inet project_egress\n' if existing.returncode == 0 else ''
nft(prefix + base_rules())
PY
# Keep invalidated established TCP flows from reappearing on a later grant.
sysctl -w net.netfilter.nf_conntrack_tcp_loose=0
exec /usr/local/bin/dockerd-entrypoint.sh "$@"
