#!/usr/bin/env bash
# Build sequentially outside the VM; only pinned runtime binaries enter the guest.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]]
: "${RUNNER_TEMP:?}" "${PROBE_EVIDENCE:?}"
assets="$RUNNER_TEMP/verity-boot-assets"
mkdir -p "$assets/runtime/bin" "$assets/runtime/opt" "$PROBE_EVIDENCE"
node scripts/build-project-egress-host.mjs
node scripts/probes/project-egress/build-boot-assets.mjs "$assets"
cp "$(command -v node)" "$assets/node"
docker build -f deploy/gvisor-ci.Dockerfile -t verity-boot-runtime:local . > "$PROBE_EVIDENCE/runtime-build.txt" 2>&1
runtime=$(docker create verity-boot-runtime:local)
trap 'docker rm -f "$runtime" >/dev/null' EXIT
docker cp "$runtime:/usr/local/bin/." "$assets/runtime/bin/"
docker cp "$runtime:/opt/verity" "$assets/runtime/opt/verity"
docker cp "$runtime:/etc/docker/daemon.json" "$assets/runtime/daemon.json"
docker build -f deploy/verity-sandbox.Dockerfile -t verity-boot-runner:local . > "$PROBE_EVIDENCE/runner-build.txt" 2>&1
docker build -f scripts/probes/project-egress/BootRunner.Dockerfile --build-arg RUNNER_IMAGE=verity-boot-runner:local -t verity-boot-observed-runner:local . > "$PROBE_EVIDENCE/observed-runner-build.txt" 2>&1
docker build -f deploy/project-relay.Dockerfile -t verity-boot-relay:local . > "$PROBE_EVIDENCE/relay-build.txt" 2>&1
registry='registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e'
docker pull "$registry" > "$PROBE_EVIDENCE/registry-pull.txt"
docker tag "$registry" verity-boot-registry:local
docker save -o "$assets/images.tar" verity-boot-observed-runner:local verity-boot-relay:local verity-boot-registry:local
# Guest setup verifies actual binaries too; this records the bytes transported.
(cd "$assets" && sha256sum node runtime/bin/docker runtime/bin/dockerd > runtime-sha256.txt)
tar -C "$assets" -cf "$RUNNER_TEMP/verity-boot-assets.tar" .
