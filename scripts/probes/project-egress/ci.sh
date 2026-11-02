#!/usr/bin/env bash
# Disposable GitHub Actions runner only. Never attach to a production Docker daemon.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'This launcher requires a disposable GitHub Actions runner.' >&2; exit 1; }
: "${RUNNER_TEMP:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${PROBE_EVIDENCE:?}"
probe_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$PROBE_EVIDENCE"
work=$(mktemp -d "$RUNNER_TEMP/project-egress.XXXXXX")
name="verity-egress-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
runtime_image="$name-runtime:local"
host_image="$name-host:local"
fixture_image="$name-fixture:local"
runner_image="$name-runner:local"
relay_image="$name-relay:local"
export DOCKER_HOST=unix:///var/run/docker.sock
export DOCKER_CONFIG="$work/docker-config"
unset DOCKER_CONTEXT BUILDKIT_HOST BUILDX_BUILDER
mkdir -p "$DOCKER_CONFIG"
cleanup() {
  status=$?
  trap - EXIT
  set +e
  docker logs "$name" > "$PROBE_EVIDENCE/daemon.txt" 2>&1
  docker exec "$name" nft list ruleset > "$PROBE_EVIDENCE/firewall-exit.txt" 2>&1
  for receiver in receiver other gateway; do
    docker exec "$name" docker logs "pe-$receiver" > "$PROBE_EVIDENCE/$receiver-exit.jsonl" 2>&1
  done
  docker rm --force --volumes "$name" >/dev/null 2>&1
  docker image rm "$host_image" "$runtime_image" "$fixture_image" "$runner_image" "$relay_image" >/dev/null 2>&1
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Bound this job from the real available memory, never the host core count.
# No Node heap override; the fixture fails early if the runner cannot afford it.
python3 - <<'PY' > "$PROBE_EVIDENCE/limits.json"
import json
import subprocess
from pathlib import Path
ceiling_path = Path('/sys/fs/cgroup/memory.max')
ceiling = ceiling_path.read_text().strip() if ceiling_path.exists() else 'max'
available = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))) * 1024
if ceiling != 'max':
    used = int(Path('/sys/fs/cgroup/memory.current').read_text())
    available = min(available, int(ceiling) - used)
else:
    constrained = int(subprocess.check_output(['node', '-p', 'process.constrainedMemory()'], text=True).strip() or 0)
    if 0 < constrained < 2 ** 60:
        available = min(available, constrained)
cap = min(3 * 1024 ** 3, available // 2)
if cap < 2 * 1024 ** 3:
    raise SystemExit('At least 4 GiB available memory is required for this disposable fixture')
print(json.dumps({'memory': cap, 'cpus': 1, 'pids': 2048}))
PY
memory_bytes=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["memory"])' "$PROBE_EVIDENCE/limits.json")
docker version > "$PROBE_EVIDENCE/docker-version.txt"
cp deploy/gvisor/versions.env "$PROBE_EVIDENCE/runtime-pins.env"
docker build -f deploy/gvisor-ci.Dockerfile -t "$runtime_image" . > "$PROBE_EVIDENCE/runtime-build.txt" 2>&1
docker build -f "$probe_dir/Host.Dockerfile" --build-arg "RUNSC_SOURCE_IMAGE=$runtime_image" -t "$host_image" . > "$PROBE_EVIDENCE/host-build.txt" 2>&1
docker build -f "$probe_dir/Fixture.Dockerfile" -t "$fixture_image" . > "$PROBE_EVIDENCE/fixture-build.txt" 2>&1
docker build -f deploy/verity-sandbox.Dockerfile -t "$runner_image" . > "$PROBE_EVIDENCE/runner-build.txt" 2>&1
docker build -f deploy/project-relay.Dockerfile -t "$relay_image" . > "$PROBE_EVIDENCE/relay-build.txt" 2>&1
docker image inspect "$runner_image" "$relay_image" "$runtime_image" "$host_image" "$fixture_image" --format '{{.Id}} {{json .RepoDigests}}' > "$PROBE_EVIDENCE/images.txt"
docker run -d --privileged --name "$name" --memory "$memory_bytes" --memory-swap "$memory_bytes" --cpus 1 --pids-limit 2048 \
  --sysctl net.ipv6.conf.all.disable_ipv6=0 --sysctl net.ipv6.conf.all.forwarding=1 \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  --mount "type=bind,src=$PROBE_EVIDENCE,dst=/evidence" \
  -e DOCKER_TLS_CERTDIR= -e PROJECT_EGRESS_DISPOSABLE=yes "$host_image" --host=unix:///var/run/docker.sock > "$PROBE_EVIDENCE/host-id.txt"
ready() {
  for attempt in $(seq 1 120); do
    if docker exec "$name" docker info >/dev/null 2>&1; then return; fi
    sleep 0.25
  done
  echo 'Isolated Docker daemon did not become ready' >&2
  return 1
}
ready
docker save "$fixture_image" | docker exec -i "$name" docker load > "$PROBE_EVIDENCE/image-load.txt"
docker exec "$name" docker tag "$fixture_image" project-egress-fixture:local
docker save "$runner_image" "$relay_image" | docker exec -i "$name" docker load >> "$PROBE_EVIDENCE/image-load.txt"
docker exec "$name" docker tag "$runner_image" project-egress-runner:local
docker exec "$name" docker tag "$relay_image" project-egress-relay:local
timeout 240 docker exec "$name" node /probe/host-smoke.mjs > "$PROBE_EVIDENCE/host-smoke.txt" 2>&1
python3 "$probe_dir/composed-proof.py" "$PROBE_EVIDENCE" > "$PROBE_EVIDENCE/composed-verification.json"
timeout 240 docker exec "$name" node /probe/adapter-smoke.mjs > "$PROBE_EVIDENCE/adapter-smoke.txt" 2>&1
python3 "$probe_dir/deadline-adapter-proof.py" "$PROBE_EVIDENCE" > "$PROBE_EVIDENCE/adapter-deadline-verification.json"
# No project probe receives the outer/inner Docker socket or evidence mount.
timeout 600 docker exec "$name" python3 /probe/probe.py before-restart > "$PROBE_EVIDENCE/before-restart.txt" 2>&1
# A real daemon/network-namespace restart, with project restart policies active.
docker restart --time 3 "$name" > "$PROBE_EVIDENCE/daemon-restart.txt"
ready
timeout 240 docker exec "$name" python3 /probe/probe.py after-restart > "$PROBE_EVIDENCE/after-restart.txt" 2>&1
python3 "$probe_dir/verify.py" "$PROBE_EVIDENCE/result.json"
