#!/usr/bin/env bash
# Disposable GitHub runner only: times this repository's own devcontainer build,
# step by step, on the production gVisor builder service and on a runc worker
# from the same pinned BuildKit, so a slow build can be attributed to a step.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'GitHub Actions only' >&2; exit 1; }
: "${RUNNER_TEMP:?}" "${PROBE_EVIDENCE:?}" "${DEVCONTAINER_CLI:?}"
mkdir -p "$PROBE_EVIDENCE"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

sudo bash deploy/buildkit/install.sh > "$PROBE_EVIDENCE/install.log" 2>&1
sudo systemctl show verity-buildkit -p MemoryMax -p CPUQuotaPerSecUSec > "$PROBE_EVIDENCE/limits.txt"
sudo journalctl -q -o cat -u verity-buildkit | grep -F 'found worker' > "$PROBE_EVIDENCE/worker.txt" || true

# The runc reference: same pinned daemon and snapshotter, host network, no gVisor.
reference=$RUNNER_TEMP/runc-reference
mkdir -p "$reference"
cat > "$reference/buildkitd.toml" <<EOF
root = "$reference/state"
[grpc]
  address = ["unix://$reference/buildkitd.sock"]
[worker.oci]
  enabled = true
  binary = "$(command -v runc)"
  snapshotter = "overlayfs"
  max-parallelism = 1
[worker.containerd]
  enabled = false
EOF
sudo /usr/local/libexec/verity-buildkit/buildkitd --config "$reference/buildkitd.toml" > "$PROBE_EVIDENCE/runc-daemon.log" 2>&1 &
for _ in $(seq 1 30); do sudo test -S "$reference/buildkitd.sock" && break; sleep 1; done
sudo chmod 0666 "$reference/buildkitd.sock" /run/verity-buildkit/buildkitd.sock

docker buildx create --name timing-gvisor --driver remote unix:///run/verity-buildkit/buildkitd.sock > /dev/null
docker buildx create --name timing-runc --driver remote "unix://$reference/buildkitd.sock" > /dev/null

node_ref=$(sed -n "s/^  '\(ghcr.io\/devcontainers\/features\/node@sha256:[a-f0-9]*\)';$/\1/p" packages/server/src/provisioner.ts)
[[ -n $node_ref ]] || { echo 'Node feature pin not found in provisioner.ts' >&2; exit 1; }
features=$(jq -cn --arg node "$node_ref" \
    '{($node): {version: "26.12.1"}, "ghcr.io/heey-global/verity/verity-sandbox-toolkit:latest": {installRunnerSupervisor: true}}')

# Prints "<seconds> <step>" for every completed vertex in a plain-progress log.
steps() {
    awk '/^#[0-9]+ / && !($1 in name) && $2 != "DONE" && $2 != "CACHED" && $2 != "ERROR" {
             line = $0; sub(/^#[0-9]+ /, "", line); name[$1] = substr(line, 1, 110) }
         /^#[0-9]+ DONE/ { done[$1] = $3 }
         END { for (k in done) printf "%s\t%s\t%s\n", substr(k, 2), done[k], name[k] }' "$1" |
        sort -n | cut -f2-
}

run() {
    local label=$1 builder=$2 log=$PROBE_EVIDENCE/$1.log start status=0
    start=$(date +%s)
    BUILDX_BUILDER=$builder BUILDKIT_PROGRESS=plain timeout 75m "$DEVCONTAINER_CLI" build \
        --workspace-folder "$PWD" --config "$PWD/.devcontainer/devcontainer.json" \
        --image-name "timing-$label" --no-cache --output "type=docker,dest=$RUNNER_TEMP/$label.tar" \
        --additional-features "$features" > "$log" 2>&1 || status=$?
    local seconds=$(( $(date +%s) - start ))
    rm -f "$RUNNER_TEMP/$label.tar"
    {
        printf '\n### %s: %s s (exit %s)\n\n```\n' "$label" "$seconds" "$status"
        steps "$log"
        grep -E '^(ERROR|#[0-9]+ ERROR)' "$log" | head -n 5 || true
        printf '```\n'
    } | tee -a "$summary"
}

run gvisor-production timing-gvisor
run runc-reference timing-runc
# Same production service without its CPU and memory ceilings, for attribution.
sudo systemctl set-property --runtime verity-buildkit CPUQuota= MemoryMax=infinity
run gvisor-unbounded timing-gvisor
