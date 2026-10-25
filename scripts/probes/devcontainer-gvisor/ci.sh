#!/usr/bin/env bash
# CI experiment only. No production daemon, shared builder, production registry token or global prune.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'Run this experiment in GitHub Actions.' >&2; exit 1; }
: "${DEVCONTAINER_CLI:?}" "${PROBE_EVIDENCE:?}" "${RUNNER_TEMP:?}"
probe_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$PROBE_EVIDENCE"
work="$(mktemp -d "$RUNNER_TEMP/devcontainer-gvisor.XXXXXX")"
name="verity-devc-probe-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
runtime_image="$name-runtime:local"
worker_image="$name-worker:local"
positive_image="$name:positive"
missing_image="$name:missing-runtime"
stopped_image="$name:stopped-builder"
# Ignore inherited daemon/builder/registry settings. All images remain on this CI host.
export DOCKER_HOST=unix:///var/run/docker.sock
export DOCKER_CONFIG="$work/docker-config"
unset DOCKER_CONTEXT BUILDKIT_HOST BUILDX_BUILDER
mkdir -p "$DOCKER_CONFIG" "$work/socket" "$work/fixture"
cleanup() {
    status=$?
    trap - EXIT
    set +e
    docker logs "$name" > "$PROBE_EVIDENCE/buildkit.log" 2>&1
    mkdir -p "$PROBE_EVIDENCE/runtime"
    docker cp "$name:/evidence/." "$PROBE_EVIDENCE/runtime/"
    docker exec "$name" rm -f /run/probe/buildkitd.sock
    docker buildx rm "$name"
    docker rm -fv "$name-marker" "$name"
    docker image rm "$positive_image" "$missing_image" "$stopped_image" "$worker_image" "$runtime_image"
    if [[ ${PROBE_PRIVATE_REGISTRY:-false} == true && -n ${registry_container:-} ]]; then
        registry_cleanup
    fi
    cleanup_failed=false
    if [[ -n ${registry_container:-} ]] && docker inspect "$registry_container" > /dev/null 2>&1; then cleanup_failed=true; fi
    if ! docker info > /dev/null 2>&1; then cleanup_failed=true; fi
    for container in "$name-marker" "$name"; do
        if docker inspect "$container" > /dev/null 2>&1; then cleanup_failed=true; fi
    done
    for image in "$positive_image" "$missing_image" "$stopped_image" "$worker_image" "$runtime_image"; do
        if docker image inspect "$image" > /dev/null 2>&1; then cleanup_failed=true; fi
    done
    if docker buildx inspect "$name" > /dev/null 2>&1; then cleanup_failed=true; fi
    printf 'named experiment resources remain or daemon unavailable: %s\n' "$cleanup_failed" \
        > "$PROBE_EVIDENCE/cleanup.txt"
    if [[ $cleanup_failed == true && $status -eq 0 ]]; then status=1; fi
    # Worker-created files are root-owned. Make only the experiment evidence readable.
    sudo chown -R "$(id -u):$(id -g)" "$PROBE_EVIDENCE"
    sudo chmod -R u+rX "$PROBE_EVIDENCE"
    if [[ ${PROBE_PRIVATE_REGISTRY:-false} == true && -n ${registry_container:-} ]]; then
        if ! registry_scrub_evidence; then
            # If redaction cannot complete, withhold diagnostics rather than upload raw files.
            rm -rf "$PROBE_EVIDENCE"
            mkdir -p "$PROBE_EVIDENCE"
            status=1
        fi
    fi
    printf '%s\n' "$status" > "$PROBE_EVIDENCE/exit-code.txt"
    exit "$status"
}
trap cleanup EXIT

# The worker cap stays below half the available memory, with a 2 GiB upper bound.
memory_bytes=$(node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';
let available;
try {
  const ceiling = Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim());
  const used = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
  if (Number.isFinite(ceiling) && ceiling > 0 && ceiling < 2 ** 60) available = ceiling - used;
} catch { /* Fall back to Node's constraint discovery. */ }
if (available === undefined) {
  const constrained = process.constrainedMemory();
  available = constrained > 0 && constrained < 2 ** 60 ? constrained - process.memoryUsage().rss : 0;
  // MemAvailable also limits the cap when there is no readable cgroup ceiling.
  const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  const hostAvailable = match ? Number(match[1]) * 1024 : 0;
  available = available > 0 ? Math.min(available, hostAvailable) : hostAvailable;
}
const cap = Math.floor(Math.min(2 * 1024 ** 3, available / 2));
if (cap < 512 * 1024 ** 2) throw new Error('Insufficient memory for the isolated worker');
console.log(cap);
NODE
)
printf 'memory=%s bytes; cpus=1; pids=512; worker parallelism=1\n' "$memory_bytes" > "$PROBE_EVIDENCE/limits.txt"
docker version > "$PROBE_EVIDENCE/docker-version.txt"
docker buildx version > "$PROBE_EVIDENCE/buildx-version.txt"
"$DEVCONTAINER_CLI" --version > "$PROBE_EVIDENCE/devcontainer-version.txt"
cp "$probe_dir/buildkitd.toml" "$PROBE_EVIDENCE/buildkitd.toml"
cp deploy/gvisor/versions.env "$PROBE_EVIDENCE/runtime-pins.txt"

# Reuse the existing checksum-verified runtime image without starting its Docker daemon.
docker build -f deploy/gvisor-ci.Dockerfile -t "$runtime_image" . > "$PROBE_EVIDENCE/runtime-image.log" 2>&1
docker build -f "$probe_dir/BuildKit.Dockerfile" --build-arg "RUNSC_SOURCE_IMAGE=$runtime_image" \
    -t "$worker_image" . > "$PROBE_EVIDENCE/worker-image.log" 2>&1
worker_options=()
if [[ ${PROBE_PRIVATE_REGISTRY:-false} == true ]]; then
    source "$probe_dir/private-registry.sh"
    registry_start
    # CI only: the loopback TLS registry is reachable from the worker, never published externally.
    worker_options+=(--network host --add-host registry.verity.test:127.0.0.1 --mount "type=bind,src=$work/registry/cert.pem,dst=/etc/ssl/certs/probe-registry.pem,readonly")
fi
docker run -d "${worker_options[@]}" --privileged --memory "$memory_bytes" --memory-swap "$memory_bytes" \
    --cpus 1 --pids-limit 512 --name "$name" \
    --mount "type=bind,src=$work/socket,dst=/run/probe" \
    "$worker_image" --addr unix:///run/probe/buildkitd.sock
ready=false
for attempt in $(seq 1 60); do
    if docker exec "$name" buildctl --addr unix:///run/probe/buildkitd.sock debug workers --verbose \
        > "$PROBE_EVIDENCE/workers.txt" 2>&1; then ready=true; break; fi
    sleep 1
done
[[ $ready == true ]] || { echo 'runsc worker did not become ready' >&2; exit 1; }
if [[ ${PROBE_PRIVATE_REGISTRY:-false} == true ]]; then
    docker exec "$name" sh -c 'cat /etc/ssl/certs/probe-registry.pem >> /etc/ssl/certs/ca-certificates.crt'
fi
docker exec "$name" chmod 0666 /run/probe/buildkitd.sock
docker exec "$name" /usr/local/bin/runsc-real --version > "$PROBE_EVIDENCE/runsc-version.txt"
docker inspect "$name" > "$PROBE_EVIDENCE/worker-container.json"
docker buildx create --name "$name" --driver remote "unix://$work/socket/buildkitd.sock"
export BUILDX_BUILDER="$name"
docker buildx inspect "$name" > "$PROBE_EVIDENCE/builder.txt"
cp -R "$probe_dir/.devcontainer" "$work/fixture/"
# Read the existing repository base-image pin instead of introducing a second moving tag.
PROBE_CONFIG="$work/fixture/.devcontainer/devcontainer.json" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const base = /^FROM (node:[^\s]+@sha256:[a-f0-9]{64})/m.exec(readFileSync('deploy/preview-edge.Dockerfile', 'utf8'))?.[1];
if (!base) throw new Error('Missing digest-pinned probe base');
const path = process.env.PROBE_CONFIG;
const config = JSON.parse(readFileSync(path, 'utf8'));
config.build.args = { PROBE_BASE_IMAGE: base };
writeFileSync(path, JSON.stringify(config));
NODE
build_probe() {
    timeout 300 "$DEVCONTAINER_CLI" build --workspace-folder "$work/fixture" \
        --image-name "$1" --no-cache --log-level trace
}
if [[ ${PROBE_PRIVATE_REGISTRY:-false} == true ]]; then
    public_base=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).build.args.PROBE_BASE_IMAGE' "$work/fixture/.devcontainer/devcontainer.json")
    registry_seed_base "$public_base"
    # Require independently protected image and Feature manifests before granting auth.
    for resource in probe/base/manifests/fixture probe/isolation-probe/manifests/1; do
        status=$(curl --silent --cacert "$work/registry/cert.pem" -o /dev/null -w '%{http_code}' "https://$registry_address/v2/$resource")
        [[ $status == 401 ]] || { echo 'Private resource accepted anonymous access' >&2; exit 1; }
    done
    PROBE_CONFIG="$work/fixture/.devcontainer/devcontainer.json" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.env.PROBE_CONFIG;
const config = JSON.parse(readFileSync(path, 'utf8'));
config.build.args.PROBE_BASE_IMAGE = 'registry.verity.test:5443/probe/base:fixture';
config.features = { 'registry.verity.test:5443/probe/isolation-probe:1': {} };
writeFileSync(path, JSON.stringify(config));
NODE
    # Feature denial is tested with the public base; image denial with the local Feature.
    cp "$work/fixture/.devcontainer/devcontainer.json" "$work/private-config.json"
    for denied_resource in feature image; do
        PROBE_CONFIG="$work/fixture/.devcontainer/devcontainer.json" \
            PUBLIC_BASE="$public_base" DENIED_RESOURCE="$denied_resource" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.env.PROBE_CONFIG, 'utf8'));
if (process.env.DENIED_RESOURCE === 'feature') config.build.args.PROBE_BASE_IMAGE = process.env.PUBLIC_BASE;
else {
  config.build.args.PROBE_BASE_IMAGE = 'registry.verity.test:5443/probe/base:fixture';
  config.features = { './features/isolation-probe': {} };
}
writeFileSync(process.env.PROBE_CONFIG, JSON.stringify(config));
NODE
        expect_auth_failure "$missing_image" "$PROBE_EVIDENCE/anonymous-$denied_resource.log"
    done
    cp "$work/private-config.json" "$work/fixture/.devcontainer/devcontainer.json"
    cp "$work/publisher/config.json" "$DOCKER_CONFIG/config.json"
    printf 'TLS registry: anonymous image and Feature manifests rejected; anonymous CLI rejected; authenticated build follows.\n' > "$PROBE_EVIDENCE/registry-auth.txt"
fi
build_probe "$positive_image" > "$PROBE_EVIDENCE/positive.log" 2>&1
docker create --name "$name-marker" "$positive_image" > /dev/null
docker cp "$name-marker:/verity-dockerfile-probe" "$PROBE_EVIDENCE/dockerfile-marker.txt"
docker cp "$name-marker:/verity-feature-probe" "$PROBE_EVIDENCE/feature-marker.txt"
docker rm "$name-marker"
mkdir -p "$PROBE_EVIDENCE/runtime"
docker cp "$name:/evidence/." "$PROBE_EVIDENCE/runtime/"
sudo chown -R "$(id -u):$(id -g)" "$PROBE_EVIDENCE/runtime"
node "$probe_dir/verify-evidence.mjs" "$PROBE_EVIDENCE"

expect_failure() {
    local tag=$1 log=$2 expected=$3 status
    set +e
    build_probe "$tag" > "$log" 2>&1
    status=$?
    set -e
    # A timeout or OOM is not evidence of correct rejection.
    [[ $status -ne 0 && $status -ne 124 && $status -ne 137 ]] || return 1
    grep -F "$expected" "$log" > /dev/null
    if docker image inspect "$tag" > /dev/null 2>&1; then
        echo 'Unexpected image from a failed worker: possible fallback' >&2
        return 1
    fi
    printf 'expected rejection: status=%s, no output image\n' "$status"
}
docker exec "$name" mv /usr/local/bin/runsc-real /usr/local/bin/runsc-disabled
expect_failure "$missing_image" "$PROBE_EVIDENCE/missing-runtime.log" runsc-real
docker stop "$name"
[[ $(docker inspect --format '{{.State.Running}}' "$name") == false ]]
expect_failure "$stopped_image" "$PROBE_EVIDENCE/stopped-builder.log" 'context deadline exceeded'
printf 'Dockerfile and Feature ran through runsc; both unavailable-worker tests rejected.\n' \
    > "$PROBE_EVIDENCE/result.txt"
