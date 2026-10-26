#!/usr/bin/env bash
# Disposable GitHub runner only: upgrade a builder installed by an older release, with the
# hand edits an affected host carried, through the path a managed update takes.
#
# 1. Install the builder exactly as UPGRADE_FROM installed it (host network, no CNI), then
#    apply the manual state seen on affected hosts: a [dns] section in buildkitd.toml and a
#    hand-installed CNI plugin directory. Prove a networked RUN step fails on it.
# 2. Put the host components of the signed release UPGRADE_TO in place, as that release's
#    installer does, and hand verity-host-builder the request the Updater writes: the
#    official image digest, nothing else. The real component verifies the real release
#    signature and installs the builder bundle out of the image.
# 3. Require a restarted builder on CNI networking with the hand edits replaced, and DNS,
#    HTTPS and apt-get in an uncached build, twice. A second request for the same image must
#    leave the running builder alone.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'GitHub Actions only' >&2; exit 1; }
: "${RUNNER_TEMP:?}" "${PROBE_EVIDENCE:?}" "${UPGRADE_FROM:?}" "${UPGRADE_TO:?}"
mkdir -p "$PROBE_EVIDENCE"
repository=ghcr.io/heey-global/verity/verity-server
state=/var/lib/verity/host-runtime
work=$(mktemp -d "$RUNNER_TEMP/verity-builder-upgrade.XXXXXX")
name="verity-builder-upgrade-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
cleanup() {
    status=$?
    trap - EXIT
    set +e
    sudo journalctl -u verity-buildkit -u verity-host-builder --no-pager > "$PROBE_EVIDENCE/journal.log"
    sudo cp /var/lib/verity/host-builder/reconcile.log "$PROBE_EVIDENCE/" 2>/dev/null
    sudo systemctl disable --now verity-host-builder.path verity-buildkit
    docker image rm "$name:old" "$name:new" "$name:new2" > /dev/null 2>&1
    sudo chown -R "$(id -u):$(id -g)" "$PROBE_EVIDENCE"
    printf '%s\n' "$status" > "$PROBE_EVIDENCE/exit-code.txt"
    exit "$status"
}
trap cleanup EXIT

await_socket() {
    local attempt
    for attempt in $(seq 1 60); do
        if sudo systemctl is-active --quiet verity-buildkit && [[ -S /run/verity-buildkit/buildkitd.sock ]]; then
            return 0
        fi
        sleep 1
    done
    return 1
}
main_pid() { sudo systemctl show verity-buildkit -p MainPID --value; }

# The network probe build, through the Server's own spawner, as the Server's group.
cp -R scripts/probes/devcontainer-gvisor/network/.devcontainer "$work/"
PROBE_CONFIG="$work/.devcontainer/devcontainer.json" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const base = /^FROM (node:[^\s]+@sha256:[a-f0-9]{64})/m.exec(readFileSync('deploy/preview-edge.Dockerfile', 'utf8'))?.[1];
if (!base) throw new Error('Missing base pin');
const config = JSON.parse(readFileSync(process.env.PROBE_CONFIG, 'utf8'));
config.build.args = { PROBE_BASE_IMAGE: base };
writeFileSync(process.env.PROBE_CONFIG, JSON.stringify(config));
NODE
spawn_build() {
    sudo --preserve-env=PATH setpriv --reuid "$(id -u)" \
        --regid "$(getent group verity-buildkit | cut -d: -f3)" --init-groups \
        env PATH="$PWD/node_modules/.bin:$PATH" VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT=unix:///run/verity-buildkit/buildkitd.sock \
        node scripts/probes/devcontainer-gvisor/server-spawner.mjs "$work" "$1"
}

# ── 1. the builder an older release installed, plus the manual edits ──────────────────────
old="$work/old"
mkdir -p "$old"
git archive "$UPGRADE_FROM" deploy | tar -x -C "$old"
! grep -q networkMode "$old/deploy/buildkit/buildkitd.toml" ||
    { echo "$UPGRADE_FROM already configures CNI; pick an older release" >&2; exit 1; }
sudo VERITY_BUILDKIT_GID=1102 bash "$old/deploy/buildkit/install.sh" > "$PROBE_EVIDENCE/old-install.log" 2>&1
printf '\n[dns]\n  nameservers = ["1.1.1.1", "9.9.9.9"]\n' | sudo tee -a /etc/verity-buildkit/buildkitd.toml > /dev/null
sudo install -d -m 0755 /usr/local/libexec/verity-buildkit/cni-v1.6.2
printf 'hand-installed\n' | sudo tee /usr/local/libexec/verity-buildkit/cni-v1.6.2/bridge > /dev/null
sudo systemctl restart verity-buildkit
await_socket
# The receipt the installer of that release wrote after verifying the builder.
sudo install -d -m 0700 "$state"
printf '{"version":1,"gid":1102}\n' | sudo tee "$state/devcontainer-builder.json" > /dev/null
sudo cp /etc/verity-buildkit/buildkitd.toml "$PROBE_EVIDENCE/old-buildkitd.toml"
if spawn_build "$name:old" > "$PROBE_EVIDENCE/old-network.log" 2>&1; then
    echo 'the old builder unexpectedly reached the network; this run proves nothing' >&2
    exit 1
fi
tail -n 20 "$PROBE_EVIDENCE/old-network.log"
old_pid=$(main_pid)

# ── 2. the target release's host components, and the Updater's request ────────────────────
docker pull --quiet "$repository:$UPGRADE_TO" > /dev/null
image=$(docker image inspect --format '{{ range .RepoDigests }}{{ println . }}{{ end }}' "$repository:$UPGRADE_TO" |
    grep -E "^$repository@sha256:[a-f0-9]{64}$" | head -n 1)
[[ -n $image ]]
printf '%s\n' "$image" > "$PROBE_EVIDENCE/target-image.txt"
[[ $(docker image inspect --format '{{ index .Config.Labels "org.verity.devcontainer-builder" }}' "$image") == 1 ]] ||
    { echo "$UPGRADE_TO does not declare the builder contract" >&2; exit 1; }
payload="$work/payload"
mkdir -p "$payload"
container=$(docker create "$image")
docker cp "$container:/opt/verity-install/deploy/host" - | tar -x -C "$payload"
docker rm "$container" > /dev/null
# What verity-install of that release puts in place (deploy/bin/verity-install).
sudo install -d -m 0755 /usr/local/libexec/verity
for script in verity-host-runtime verity-host-builder; do
    sudo install -m 0755 "$payload/host/$script" "/usr/local/libexec/verity/$script"
done
for unit in verity-host-runtime.path verity-host-runtime.service verity-host-builder.path verity-host-builder.service; do
    sudo install -m 0644 "$payload/host/$unit" "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable --now verity-host-builder.path
printf '{"version":1,"trigger":"systemd-path","builder":"systemd-path"}\n' | sudo tee "$state/agent.json" > /dev/null

request() {
    local id=$1 tmp
    tmp=$(mktemp)
    jq -cn --arg id "$id" --arg image "$image" '{version: 1, id: $id, image: $image}' > "$tmp"
    sudo install -m 0600 "$tmp" "$state/.builder-request.json.tmp"
    sudo mv -f "$state/.builder-request.json.tmp" "$state/builder-request.json"
    rm -f "$tmp"
}
await_answer() {
    local id=$1 attempt
    for attempt in $(seq 1 1200); do
        if sudo test -f "$state/builder-result.json" &&
            [[ $(sudo jq -r '.id' "$state/builder-result.json") == "$id" ]]; then
            sudo cat "$state/builder-result.json"
            sudo jq -e '.ok == true' "$state/builder-result.json" > /dev/null
            return
        fi
        sleep 1
    done
    echo "no answer to $id" >&2
    return 1
}
request upgrade-1
await_answer upgrade-1 | tee "$PROBE_EVIDENCE/answer-1.json"

# ── 3. the upgraded builder ───────────────────────────────────────────────────────────────
await_socket
new_pid=$(main_pid)
sudo cp /etc/verity-buildkit/buildkitd.toml /etc/verity-buildkit/network.env /etc/verity-buildkit/cni.conflist "$PROBE_EVIDENCE/"
[[ $new_pid != "$old_pid" ]] || { echo 'the builder was not restarted' >&2; exit 1; }
grep -Fx '  networkMode = "cni"' /etc/verity-buildkit/buildkitd.toml
! grep -q '^\[dns\]' /etc/verity-buildkit/buildkitd.toml || { echo 'the hand-added [dns] section survived' >&2; exit 1; }
! grep -q hand-installed /usr/local/libexec/verity-buildkit/cni/bridge || { echo 'the hand-installed CNI copy survived' >&2; exit 1; }
for build in new new2; do
    if ! spawn_build "$name:$build" > "$PROBE_EVIDENCE/$build-network.log" 2>&1; then
        tail -n 80 "$PROBE_EVIDENCE/$build-network.log" >&2
        exit 1
    fi
done
# Every later update asks again; an unchanged builder keeps running.
request upgrade-2
await_answer upgrade-2 | tee "$PROBE_EVIDENCE/answer-2.json"
[[ $(main_pid) == "$new_pid" ]] || { echo 'an unchanged builder was restarted' >&2; exit 1; }
printf 'Upgraded %s builder with manual edits to %s through verity-host-builder; DNS, HTTPS and apt-get pass.\n' \
    "$UPGRADE_FROM" "$UPGRADE_TO" | tee "$PROBE_EVIDENCE/result.txt"
