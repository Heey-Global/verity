#!/usr/bin/env bash
# Disposable GitHub runner only: installs the real host service and uses the Server spawner.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'GitHub Actions only' >&2; exit 1; }
: "${RUNNER_TEMP:?}" "${PROBE_EVIDENCE:?}"
mkdir -p "$PROBE_EVIDENCE/runtime"
work=$(mktemp -d "$RUNNER_TEMP/verity-host-builder.XXXXXX")
name="verity-host-builder-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
cleanup() {
    status=$?
    trap - EXIT
    set +e
    sudo journalctl -u verity-buildkit --no-pager > "$PROBE_EVIDENCE/service.log"
    sudo cp -R /var/lib/verity-buildkit/evidence/. "$PROBE_EVIDENCE/runtime/"
    sudo systemctl disable --now verity-buildkit-snapshotter.timer
    sudo systemctl stop verity-buildkit-snapshotter.service
    sudo systemctl disable --now verity-buildkit
    sudo systemctl disable --now verity-build-storage.timer
    sudo systemctl stop verity-build-storage.service
    docker rm -fv "$name-marker"
    docker image rm "$name:positive" "$name:network" "$name:network2" "$name:missing" "$name:stopped"
    if docker image inspect "$name:positive" > /dev/null 2>&1; then status=1; fi
    if sudo systemctl is-active --quiet verity-buildkit; then status=1; fi
    if sudo systemctl is-active --quiet verity-build-storage.timer; then status=1; fi
    sudo chown -R "$(id -u):$(id -g)" "$PROBE_EVIDENCE"
    printf '%s\n' "$status" > "$PROBE_EVIDENCE/exit-code.txt"
    exit "$status"
}
trap cleanup EXIT
sudo bash deploy/buildkit/install.sh
# Exercise the production migration on this disposable host, before any client builds.
sudo systemctl stop verity-buildkit-snapshotter.timer
sudo sed -i 's/snapshotter = "auto"/snapshotter = "native"/' /etc/verity-buildkit/buildkitd.toml
sudo systemctl restart verity-buildkit
sudo /usr/local/libexec/verity-buildkit/snapshotter-migrate.sh reconcile
sudo cat /run/verity-buildkit/migration-status.json > "$PROBE_EVIDENCE/snapshotter-migration.json"
jq -e '.state == "converged"' "$PROBE_EVIDENCE/snapshotter-migration.json"
# A repeated run must not restart the worker or perform another migration.
before_pid=$(sudo systemctl show verity-buildkit -p MainPID --value)
sudo /usr/local/libexec/verity-buildkit/snapshotter-migrate.sh reconcile
[[ $(sudo systemctl show verity-buildkit -p MainPID --value) == "$before_pid" ]]
sudo /usr/local/libexec/verity-buildkit/runsc-real --version > "$PROBE_EVIDENCE/runsc-version.txt"
# Instrument the host-side call, then delegate to the unmodified production adapter.
sudo mkdir -p /var/lib/verity-buildkit/evidence/{bundles,runsc}
python3 - <<'PY' > "$work/runsc-evidence"
from pathlib import Path
s=Path('scripts/probes/devcontainer-gvisor/runsc-probe.sh').read_text()
s=s[:s.index('# BuildKit must snapshot')]+'''exec /usr/local/libexec/verity-buildkit/runsc --debug --debug-log=/evidence/runsc/ "$@"\n'''
print(s.replace('/evidence','/var/lib/verity-buildkit/evidence'),end='')
PY
sudo install -m 0755 "$work/runsc-evidence" /usr/local/libexec/verity-buildkit/runsc-evidence
sudo sed -i 's|binary = "/usr/local/libexec/verity-buildkit/runsc"|binary = "/usr/local/libexec/verity-buildkit/runsc-evidence"|' /etc/verity-buildkit/buildkitd.toml
sudo systemctl restart verity-buildkit
for attempt in $(seq 1 30); do
    if [[ -S /run/verity-buildkit/buildkitd.sock ]]; then break; fi
    sleep 1
done
[[ -S /run/verity-buildkit/buildkitd.sock ]]
sudo systemctl show verity-buildkit -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec -p TasksMax > "$PROBE_EVIDENCE/limits.txt"
# The limits the installer derived for this runner, in systemd's own units.
bash deploy/buildkit/resources.sh > "$PROBE_EVIDENCE/resources.txt"
quota_percent=$(sed -n 's/^CPU_QUOTA=\([0-9]*\)%$/\1/p' "$PROBE_EVIDENCE/resources.txt")
memory_mib=$(sed -n 's/^MEMORY_MAX=\([0-9]*\)M$/\1/p' "$PROBE_EVIDENCE/resources.txt")
grep -Fx "MemoryMax=$((memory_mib * 1024 * 1024))" "$PROBE_EVIDENCE/limits.txt"
grep -Fx 'MemorySwapMax=0' "$PROBE_EVIDENCE/limits.txt"
grep -Fx "CPUQuotaPerSecUSec=$((quota_percent / 100))s" "$PROBE_EVIDENCE/limits.txt"
grep -Fx 'TasksMax=512' "$PROBE_EVIDENCE/limits.txt"
main_pid=$(sudo systemctl show verity-buildkit -p MainPID --value)
[[ $main_pid =~ ^[1-9][0-9]*$ ]]
sudo systemctl is-active --quiet verity-buildkit
# InaccessiblePaths may mask a socket with a non-listening socket inode. Test
# connectivity from the service root rather than inferring authority from stat.
sudo nsenter --target "$main_pid" --mount --root --wdns=/ -- "$(command -v node)" --input-type=module - \
    /run/docker.sock /var/run/docker.sock /run/containerd/containerd.sock \
    < scripts/probes/devcontainer-gvisor/verify-worker-sockets.mjs
cp -R scripts/probes/devcontainer-gvisor/.devcontainer "$work/"
# Establish the disposable runner's actual runtime root before enabling admission.
# A missing containerd configuration is a test failure, never substituted capacity.
containerd_root=$(sudo containerd config dump | python3 -c 'import sys,tomllib; print(tomllib.loads(sys.stdin.read())["root"])')
[[ $containerd_root == /* ]]
sudo test -d "$containerd_root"
printf 'version=1\ncontainerdRoot=%s\nexportRoot=%s\nprojectRoot=%s\n' "$containerd_root" "$work" "$work" \
    | sudo tee /etc/verity-buildkit/storage-roots.conf > /dev/null
PROBE_CONFIG="$work/.devcontainer/devcontainer.json" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const base = /^FROM (node:[^\s]+@sha256:[a-f0-9]{64})/m.exec(readFileSync('deploy/preview-edge.Dockerfile', 'utf8'))?.[1];
if (!base) throw new Error('Missing base pin');
const config = JSON.parse(readFileSync(process.env.PROBE_CONFIG, 'utf8'));
config.build.args = { PROBE_BASE_IMAGE: base };
writeFileSync(process.env.PROBE_CONFIG, JSON.stringify(config));
NODE
# Enter through root, then drop to the runner with the dedicated socket group.
# Explicit sudo run-as groups are not covered by every runner sudoers policy.
# Supplementary groups retain Docker access for image loading; the Server is non-root.
run_probe() {
    sudo systemctl restart verity-build-storage.service
    sudo --preserve-env=PATH setpriv --reuid "$(id -u)" \
        --regid "$(getent group verity-buildkit | cut -d: -f3)" --init-groups \
        env PATH="$PWD/node_modules/.bin:$PATH" GITHUB_ACTIONS="$GITHUB_ACTIONS" \
        VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT=unix:///run/verity-buildkit/buildkitd.sock \
        PROBE_STORAGE_ROOT="${PROBE_STORAGE_ROOT_OVERRIDE:-$work/build-storage}" PROBE_STORAGE_REPORT=/var/lib/verity/host-diagnostics/storage.json \
        PROBE_EVIDENCE="$PROBE_EVIDENCE" PROBE_WARM="${PROBE_WARM:-0}" \
        node "$@"
}
spawn_build() {
    run_probe scripts/probes/devcontainer-gvisor/server-spawner.mjs "${2:-$work}" "$1"
}
spawn_build "$name:positive" > "$PROBE_EVIDENCE/positive.log" 2>&1
PROBE_WARM=1 spawn_build "$name:positive" > "$PROBE_EVIDENCE/warm.log" 2>&1
PROBE_WARM=1 spawn_build "$name:positive" > "$PROBE_EVIDENCE/repeated.log" 2>&1
# The runner's ext4 supports overlayfs, so "auto" must not have fallen back to
# the native snapshotter, whose full copy per step is what this setting avoids.
sudo test -d /var/lib/verity-buildkit/runc-overlayfs
# This is a fresh runner, not evidence that an installer removed older state.
sudo journalctl -q -o cat -u verity-buildkit > "$PROBE_EVIDENCE/worker-start.log"
grep -F 'found worker' "$PROBE_EVIDENCE/worker-start.log" | grep -F 'worker.snapshotter:overlayfs' > /dev/null
sudo test ! -e /var/lib/verity-buildkit/runc-native
docker create --name "$name-marker" "$name:positive" > /dev/null
docker cp "$name-marker:/verity-dockerfile-probe" "$PROBE_EVIDENCE/dockerfile-marker.txt"
docker cp "$name-marker:/verity-feature-probe" "$PROBE_EVIDENCE/feature-marker.txt"
docker rm "$name-marker"
mkdir -p "$PROBE_EVIDENCE/runtime"
sudo cp -R /var/lib/verity-buildkit/evidence/. "$PROBE_EVIDENCE/runtime/"
sudo chown -R "$(id -u):$(id -g)" "$PROBE_EVIDENCE/runtime"
node scripts/probes/devcontainer-gvisor/verify-evidence.mjs "$PROBE_EVIDENCE"
node scripts/probes/devcontainer-gvisor/image-lifecycle.mjs "$name:positive" > "$PROBE_EVIDENCE/image-lifecycle.log" 2>&1
# A RUN step must resolve names and reach package mirrors over HTTP and HTTPS
# through the production worker configuration, uncached, on a runner whose
# resolver is the systemd stub at 127.0.0.53 as on typical Ubuntu hosts.
network_work=$(mktemp -d "$RUNNER_TEMP/verity-host-builder-network.XXXXXX")
cp -R scripts/probes/devcontainer-gvisor/network/.devcontainer "$network_work/"
PROBE_CONFIG="$network_work/.devcontainer/devcontainer.json" PROBE_SOURCE="$work/.devcontainer/devcontainer.json" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const source = JSON.parse(readFileSync(process.env.PROBE_SOURCE, 'utf8'));
const config = JSON.parse(readFileSync(process.env.PROBE_CONFIG, 'utf8'));
config.build.args = source.build.args;
writeFileSync(process.env.PROBE_CONFIG, JSON.stringify(config));
NODE
readlink -f /etc/resolv.conf > "$PROBE_EVIDENCE/host-resolv-conf.txt"
cat /etc/resolv.conf >> "$PROBE_EVIDENCE/host-resolv-conf.txt"
# On failure, show the build's own output in the job log as well: the evidence
# artifact is not always reachable from where the failure is triaged.
if ! spawn_build "$name:network" "$network_work" > "$PROBE_EVIDENCE/network-egress.log" 2>&1; then
    tail -n 80 "$PROBE_EVIDENCE/network-egress.log" >&2
    sudo journalctl -u verity-buildkit --no-pager -n 60 >&2 || true
    {
        echo '--- host network state after the failed step'
        sudo cat /etc/verity-buildkit/network.env /etc/verity-buildkit/cni.conflist
        ip -4 addr; ip -4 route
        sysctl net.ipv4.ip_forward net.bridge.bridge-nf-call-iptables 2>&1 || true
        sudo iptables-save
        ls -l /usr/local/libexec/verity-buildkit/ /usr/local/libexec/verity-buildkit/cni/
        echo '--- runsc view of the step network (latest debug logs)'
        sudo bash -c 'ls -t /var/lib/verity-buildkit/evidence/runsc/*boot* 2>/dev/null | head -n 2 | xargs -r grep -hiE "netns|network|interface|link|route|eth|nic" | tail -n 60'
        sudo bash -c 'ls -t /var/lib/verity-buildkit/evidence/runsc/* 2>/dev/null | head -n 4 | xargs -r grep -hiE "\"network\"|namespace|netns" | tail -n 20'
    } >&2
    false
fi
docker create --name "$name-marker" "$name:network" > /dev/null
docker cp "$name-marker:/verity-network-probe" "$PROBE_EVIDENCE/network-marker.txt"
docker rm "$name-marker"
grep -Fx network-egress "$PROBE_EVIDENCE/network-marker.txt"
# BuildKit keeps a step's namespace for the next step, and runsc strips the
# interface of the namespace it ran in. A second networked build after the first
# is what catches a builder where only the first step after a start can reach
# anything. Neither it nor a repeated installation may add rules for the subnet.
subnet=$(sed -n 's/^SUBNET=//p' /etc/verity-buildkit/network.env)
[[ -n $subnet ]]
sudo cp /etc/verity-buildkit/network.env /etc/verity-buildkit/cni.conflist "$PROBE_EVIDENCE/"
count_subnet_rules() { sudo iptables-save | grep -cF "${subnet%.*}." || true; }
rules_after_first=$(count_subnet_rules)
if ! spawn_build "$name:network2" "$network_work" > "$PROBE_EVIDENCE/network-egress-2.log" 2>&1; then
    tail -n 60 "$PROBE_EVIDENCE/network-egress-2.log" >&2
    false
fi
rules_after_second=$(count_subnet_rules)
run_probe scripts/probes/devcontainer-gvisor/storage-lifecycle.mjs "$work" "$name:positive" \
    > "$PROBE_EVIDENCE/storage-lifecycle.log" 2>&1
run_probe scripts/probes/devcontainer-gvisor/storage-import-cancel.mjs "$work" "$name:positive" \
    > "$PROBE_EVIDENCE/import-cancellation.log" 2>&1
comparison_work=$(mktemp -d "$RUNNER_TEMP/verity-storage-comparison.XXXXXX")
sudo env GITHUB_ACTIONS="$GITHUB_ACTIONS" RUNNER_TEMP="$RUNNER_TEMP" PROBE_EVIDENCE="$PROBE_EVIDENCE" \
    "$(command -v node)" scripts/probes/devcontainer-gvisor/storage-comparison.mjs "$comparison_work" \
    > "$PROBE_EVIDENCE/storage-comparison.log" 2>&1
sudo bash deploy/buildkit/install.sh > "$PROBE_EVIDENCE/reinstall.log" 2>&1
[[ $(sed -n 's/^SUBNET=//p' /etc/verity-buildkit/network.env) == "$subnet" ]]
rules_after_reinstall=$(count_subnet_rules)
printf 'rules: first=%s second=%s reinstall=%s\n' "$rules_after_first" "$rules_after_second" "$rules_after_reinstall" | tee "$PROBE_EVIDENCE/subnet-rules.txt"
(( rules_after_second <= rules_after_first && rules_after_reinstall <= rules_after_first )) \
    || { sudo iptables-save | grep -F "${subnet%.*}." >&2; false; }
expect_rejection() {
    local tag=$1 log=$2 code
    set +e
    spawn_build "$tag" > "$log" 2>&1
    code=$?
    set -e
    [[ $code -ne 0 && $code -ne 124 && $code -ne 137 ]]
    if docker image inspect "$tag" > /dev/null 2>&1; then return 1; fi
}
socket_directory_inode=$(stat -c '%d:%i' /run/verity-buildkit)
sudo systemctl restart verity-buildkit
[[ $(stat -c '%d:%i' /run/verity-buildkit) == "$socket_directory_inode" ]]
sudo mv /usr/local/libexec/verity-buildkit/runsc-real /usr/local/libexec/verity-buildkit/runsc-disabled
expect_rejection "$name:missing" "$PROBE_EVIDENCE/missing-runtime.log"
grep -F runsc-real "$PROBE_EVIDENCE/missing-runtime.log" > /dev/null
sudo mv /usr/local/libexec/verity-buildkit/runsc-disabled /usr/local/libexec/verity-buildkit/runsc-real
sudo systemctl stop verity-buildkit
# Independent disposable admission root: the previous negative build intentionally
# retains its uncertain reservation. Never release it merely to run another probe.
PROBE_STORAGE_ROOT_OVERRIDE="$work/stopped-build-storage" expect_rejection "$name:stopped" "$PROBE_EVIDENCE/stopped-builder.log"
printf 'Real Server spawner: host service built with gVisor, loaded image, and rejected both worker failures.\n' > "$PROBE_EVIDENCE/result.txt"
