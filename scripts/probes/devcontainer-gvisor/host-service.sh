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
    sudo systemctl disable --now verity-buildkit
    docker rm -fv "$name-marker"
    docker image rm "$name:positive" "$name:missing" "$name:stopped"
    if docker image inspect "$name:positive" > /dev/null 2>&1; then status=1; fi
    if sudo systemctl is-active --quiet verity-buildkit; then status=1; fi
    sudo chown -R "$(id -u):$(id -g)" "$PROBE_EVIDENCE"
    printf '%s\n' "$status" > "$PROBE_EVIDENCE/exit-code.txt"
    exit "$status"
}
trap cleanup EXIT
sudo bash deploy/buildkit/install.sh
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
grep -Fx 'MemoryMax=2147483648' "$PROBE_EVIDENCE/limits.txt"
grep -Fx 'MemorySwapMax=0' "$PROBE_EVIDENCE/limits.txt"
grep -Fx 'CPUQuotaPerSecUSec=1s' "$PROBE_EVIDENCE/limits.txt"
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
spawn_build() {
    sudo --preserve-env=PATH setpriv --reuid "$(id -u)" \
        --regid "$(getent group verity-buildkit | cut -d: -f3)" --init-groups \
        env PATH="$PWD/node_modules/.bin:$PATH" VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT=unix:///run/verity-buildkit/buildkitd.sock \
        node scripts/probes/devcontainer-gvisor/server-spawner.mjs "$work" "$1"
}
spawn_build "$name:positive" > "$PROBE_EVIDENCE/positive.log" 2>&1
docker create --name "$name-marker" "$name:positive" > /dev/null
docker cp "$name-marker:/verity-dockerfile-probe" "$PROBE_EVIDENCE/dockerfile-marker.txt"
docker cp "$name-marker:/verity-feature-probe" "$PROBE_EVIDENCE/feature-marker.txt"
docker rm "$name-marker"
mkdir -p "$PROBE_EVIDENCE/runtime"
sudo cp -R /var/lib/verity-buildkit/evidence/. "$PROBE_EVIDENCE/runtime/"
sudo chown -R "$(id -u):$(id -g)" "$PROBE_EVIDENCE/runtime"
node scripts/probes/devcontainer-gvisor/verify-evidence.mjs "$PROBE_EVIDENCE"
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
expect_rejection "$name:stopped" "$PROBE_EVIDENCE/stopped-builder.log"
printf 'Real Server spawner: host service built with gVisor, loaded image, and rejected both worker failures.\n' > "$PROBE_EVIDENCE/result.txt"
