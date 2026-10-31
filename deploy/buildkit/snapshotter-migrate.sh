#!/usr/bin/env bash
# Release-owned convergence, never a command supplied by a Server or project.
set -euo pipefail
umask 0077
config_dir=${VERITY_BUILDKIT_CONFIG_DIR:-/etc/verity-buildkit}
run_dir=${VERITY_BUILDKIT_RUN_DIR:-/run/verity-buildkit}
state=${VERITY_SNAPSHOTTER_STATE:-/var/lib/verity/buildkit-snapshotter}
bin=${VERITY_BUILDKIT_LIBEXEC:-/usr/local/libexec/verity-buildkit}
root=${VERITY_BUILDKIT_STATE_ROOT:-/var/lib/verity-buildkit}
config=$config_dir/buildkitd.toml
journal=$state/pending.json
backup=$state/previous.toml
ctl() { timeout 15 "$bin/buildctl" --addr "unix://$run_dir/buildkitd.sock" "$@"; }
status() {
    local temp
    temp=$(mktemp "$run_dir/.migration-status.XXXXXX")
    jq -cn --arg state "$1" --arg message "$2" --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{version:1,state:$state,message:$message,observedAt:$observedAt}' > "$temp"
    chmod 0644 "$temp"
    mv -f "$temp" "$run_dir/migration-status.json"
    echo "Snapshotter migration $1: $2" >&2
}
init() {
    local gid
    gid=$(stat -c %g "$run_dir/buildkitd.sock" 2>/dev/null || getent group verity-buildkit | cut -d: -f3)
    [[ $gid =~ ^[0-9]+$ ]] || return 1
    install -d -m 0755 "$run_dir"
    # Never replace this inode: Servers hold shared flock descriptors on it.
    if [[ ! -e $run_dir/build-admission.lock ]]; then
        (set -o noclobber; : > "$run_dir/build-admission.lock") || [[ -f $run_dir/build-admission.lock ]]
    fi
    [[ -f $run_dir/build-admission.lock && ! -L $run_dir/build-admission.lock ]] || return 1
    if [[ -L $run_dir/leases ]]; then
        echo 'Admission leases must not be a symbolic link' >&2; return 1
    fi
    chmod 0644 "$run_dir/build-admission.lock"
    install -d -m 0770 -g "$gid" "$run_dir/leases"
    [[ ! -L $run_dir/reclamation-evidence ]] || return 1
    install -d -m 0770 -g "$gid" "$run_dir/reclamation-evidence"
    install -d -m 0700 "$state"
}
selected() {
    awk '/^\[/ { oci = ($0 ~ /^\[worker\.oci\][[:space:]]*(#.*)?$/) }
      oci && /^[[:space:]]*snapshotter[[:space:]]*=/ {print}' "$config" |
      sed -nE 's/^[[:space:]]*snapshotter[[:space:]]*=[[:space:]]*"(auto|native|overlayfs)"[[:space:]]*(#.*)?$/\1/p'
}
worker() {
    ctl debug workers --format '{{json .}}' | jq -er '
      select(type == "array" and length == 1) | .[0].labels |
      select(.["org.mobyproject.buildkit.worker.executor"] == "oci" and
             .["org.mobyproject.buildkit.worker.network"] == "cni" and
             .["org.mobyproject.buildkit.worker.oci.process-mode"] == "sandbox") |
      .["org.mobyproject.buildkit.worker.snapshotter"]'
}
restore() {
    if [[ -e $state/native-retired && $(selected) != overlayfs ]]; then
        status blocked "Native state was retired; native rollback is unavailable"; return 1
    fi
    if [[ -e $state/native-retired ]] && grep -Eq 'snapshotter[[:space:]]*=[[:space:]]*"(native|auto)"' "$backup"; then
        status blocked "Native rollback is unavailable after retirement"; return 1
    fi
    [[ -f $backup && ! -L $backup ]] || { status blocked 'Migration backup is unavailable'; return 1; }
    [[ $(sha256sum "$backup" | cut -d' ' -f1) == "$(jq -er .sha256 "$journal")" ]] || return 1
    cp -- "$backup" "$config.new"
    chmod 0644 "$config.new"
    sync -f "$config.new"
    mv -f "$config.new" "$config"
    sync -f "$config_dir"
}
recover() {
    init
    # Runtime admission markers disappear on reboot; only retirement recovery
    # may release the fence backed by this durable journal (even if malformed).
    if [[ -e $state/native-retirement.json || -L $state/native-retirement.json ]]; then
        : > "$run_dir/migration-pending"
        status blocked 'Native retirement recovery is pending'
    fi
    if [[ -e $state/native-retired && $(selected) != overlayfs ]]; then status blocked "Native state has been retired"; return 1; fi
    [[ -e $journal ]] || return 0
    local pid boot start actual
    pid=$(jq -er 'select(.version == 1) | .pid | select(type == "number" and . > 1)' "$journal")
    boot=$(jq -er .boot "$journal")
    start=$(jq -er .start "$journal")
    actual=$(sed -E 's/^.*\) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}' || true)
    if [[ $boot == "$(cat /proc/sys/kernel/random/boot_id)" && $actual == "$start" ]]; then
        return 0 # The live transaction is starting its trial worker.
    fi
    exec 8<"$run_dir/build-admission.lock"
    flock -w 30 8
    [[ -z $(find "$run_dir/leases" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
        status blocked 'Interrupted migration has unresolved build leases'; return 1;
    }
    restore
    jq -er .revision "$journal" > "$state/failed-revision"
    sync -f "$state/failed-revision"
    : > "$run_dir/migration-pending"
    status blocked 'Previous configuration restored; awaiting verification of the previous worker'
}
recover_verify() {
    [[ -e $journal ]] || return 0
    # A live transaction validates its trial/rollback worker itself; its parent
    # holds admission exclusively while systemd invokes this post-start helper.
    local pid boot start actual
    pid=$(jq -er .pid "$journal")
    boot=$(jq -er .boot "$journal")
    start=$(jq -er .start "$journal")
    actual=$(sed -E 's/^.*\) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}' || true)
    if [[ $boot == "$(cat /proc/sys/kernel/random/boot_id)" && $actual == "$start" ]]; then return 0; fi
    exec 8<"$run_dir/build-admission.lock"
    flock -w 30 8
    if [[ $(worker) != "$(jq -er .worker "$journal")" ]]; then
        status blocked 'Previous worker could not be verified; recovery journal retained'
        return 1
    fi
    rm -f "$journal"
    if [[ ! -e $state/native-retirement.json && ! -L $state/native-retirement.json ]]; then
        rm -f "$run_dir/migration-pending"
    fi
    sync -f "$state"
    status rolled-back 'Previous worker verified after interrupted migration recovery'
}
clients_compatible() {
    local ids id metadata
    ids=$(timeout 10 docker ps -q) || return 1
    for id in $ids; do
        metadata=$(timeout 5 docker inspect --format '{"mounts":{{json .Mounts}},"admission":{{json (index .Config.Labels "org.verity.build-admission")}}}' "$id") || return 1
        [[ ${#metadata} -le 262144 ]] || return 1
        jq -e 'type == "object" and (.mounts | type == "array")' <<< "$metadata" >/dev/null || return 1
        # A parent bind also exposes the socket. Unknown consumers defer migration.
        if jq -e --arg socket "$run_dir" '.mounts | any(.Source as $s |
            $s == "/" or $s == $socket or $s == ($socket + "/buildkitd.sock") or
            ($socket | startswith($s + "/")))' <<< "$metadata" >/dev/null; then
            jq -e --arg socket "$run_dir" '.admission == "1" and
              any(.mounts[]; .Source == $socket and .Destination == "/run/verity-buildkit" and .RW == true)' \
              <<< "$metadata" >/dev/null || return 1
        fi
    done
}
drained() {
    [[ ! -e $run_dir/migration-pending && ! -e $journal ]] || return 1
    clients_compatible || return 1
    [[ -z $(find "$run_dir/leases" -mindepth 1 -maxdepth 1 -print -quit) ]] || return 1
    ctl du --format '{{json .}}' | jq -se 'length == 1 and (.[0] | if . == null then true else type == "array" and all(.[]; .inUse == false) end)' >/dev/null
}
probe() {
    # A local rootfs from the pinned BuildKit image avoids any network pull in the solve.
    # The trusted buildctl binary is static, so it can execute inside scratch via runsc.
    local fixture
    fixture=$(mktemp -d "$state/probe.XXXXXX")
    cp "$bin/buildctl" "$fixture/buildctl"
    printf 'FROM scratch\nCOPY buildctl /buildctl\nRUN ["/buildctl", "--version"]\n' > "$fixture/Dockerfile"
    local result=0
    timeout 90 "$bin/buildctl" --addr "unix://$run_dir/buildkitd.sock" build \
        --frontend dockerfile.v0 --local "context=$fixture" --local "dockerfile=$fixture" \
        --opt force-network-mode=none --no-cache > "$fixture/output" 2>&1 || result=$?
    rm -rf -- "$fixture"
    return "$result"
}
reconcile() {
    init
    exec 7>"$state/lock"
    flock -n 7 || return 0
    if [[ -e $journal ]]; then
        recover
        # The blocker now fences new clients. Drop this descriptor so the
        # service's post-start verifier can acquire admission independently.
        exec 8<&-
        systemctl restart verity-buildkit.service
        recover_verify
    fi
    [[ $(cat "$config_dir/snapshotter-policy.conf") == $'version=1\nsnapshotter=overlayfs' ]] || {
        status blocked 'Unsupported snapshotter policy'; return 1;
    }
    local revision
    revision=$(sha256sum "${BASH_SOURCE[0]}" "$config_dir/snapshotter-policy.conf" | sha256sum | cut -d' ' -f1)
    if [[ -f $state/failed-revision && $(cat "$state/failed-revision") == "$revision" ]]; then
        status rolled-back 'This migration revision failed; waiting for a corrected release'
        return 0
    fi
    local previous
    previous=$(selected)
    [[ $previous == auto || $previous == native || $previous == overlayfs ]] || {
        status blocked 'Ambiguous existing snapshotter'; return 1;
    }
    if [[ $previous == overlayfs ]]; then
        [[ $(worker) == overlayfs ]] || { status blocked 'Configured and running snapshotters differ'; return 1; }
        status converged 'overlayfs worker verified; existing native state retained'
        return 0
    fi
    # Exclusive lock blocks new admissions while bounded waiting drains current leases.
    exec 8<"$run_dir/build-admission.lock"
    flock -w 30 8 || { status deferred 'Builds are still running'; return 0; }
    clients_compatible || { status deferred 'Waiting for all builder clients to support admission fencing'; return 0; }
    [[ -z $(find "$run_dir/leases" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
        status deferred 'Unresolved build leases remain; existing work is preserved'; return 0;
    }
    ctl du --format '{{json .}}' | jq -se 'length == 1 and (.[0] | if . == null then true else type == "array" and all(.[]; .inUse == false) end)' >/dev/null || {
        status deferred 'BuildKit activity could not be excluded'; return 0;
    }
    [[ $(worker) == native || $(worker) == overlayfs ]] || return 1
    [[ $(awk '/^\[/ {exit} /^[[:space:]]*root[[:space:]]*=/ {print}' "$config") =~ ^[[:space:]]*root[[:space:]]*=[[:space:]]*\"/var/lib/verity-buildkit\"[[:space:]]*(#.*)?$ ]] || return 1
    local runtime
    runtime=$(awk '/^\[/ { oci = ($0 ~ /^\[worker\.oci\][[:space:]]*(#.*)?$/) }
      oci && /^[[:space:]]*binary[[:space:]]*=/ {print}' "$config")
    [[ $runtime =~ ^[[:space:]]*binary[[:space:]]*=[[:space:]]*\"/usr/local/libexec/verity-buildkit/runsc\"[[:space:]]*(#.*)?$ ]] || {
        status blocked 'Existing worker does not select the managed gVisor runtime'; return 1;
    }
    local available
    available=$(df -B1 --output=avail "$root" | tail -n 1 | tr -d ' ')
    [[ $available =~ ^[0-9]+$ && $available -ge 21474836480 ]] || {
        status deferred 'At least 20 GiB free is required for migration headroom'; return 0;
    }
    # Actual same-filesystem overlay copy-up, with mounts confined to a private namespace.
    local mount_fixture
    mount_fixture=$(mktemp -d "$root/.overlay-check.XXXXXX")
    if ! timeout 15 unshare --mount --propagation private bash -euc '
        mkdir "$1/lower" "$1/upper" "$1/work" "$1/merged"
        echo before > "$1/lower/check"
        mount -t overlay overlay -o "lowerdir=$1/lower,upperdir=$1/upper,workdir=$1/work" "$1/merged"
        echo after > "$1/merged/check"
        test "$(cat "$1/lower/check")" = before
        umount "$1/merged"
    ' bash "$mount_fixture"; then
        rm -rf -- "$mount_fixture"
        status blocked 'Backing filesystem failed overlay copy-up validation'; return 1
    fi
    rm -rf -- "$mount_fixture"
    cp -- "$config" "$backup"
    sync -f "$backup"
    local temp
    temp=$(mktemp "$state/.pending.XXXXXX")
    jq -cn --arg boot "$(cat /proc/sys/kernel/random/boot_id)" --argjson pid "$$" \
        --arg start "$(sed -E 's/^.*\) //' /proc/$$/stat | awk '{print $20}')" \
        --arg revision "$revision" --arg worker "$(worker)" --arg sha256 "$(sha256sum "$backup" | cut -d' ' -f1)" \
        '{version:1,boot:$boot,pid:$pid,start:$start,sha256:$sha256,worker:$worker,revision:$revision}' > "$temp"
    sync -f "$temp"
    mv "$temp" "$journal"
    sync -f "$state"
    rollback() {
        trap - EXIT TERM INT
        jq -er .revision "$journal" > "$state/failed-revision"
        sync -f "$state/failed-revision"
        if restore && systemctl restart verity-buildkit.service && [[ $(worker) == "$(jq -er .worker "$journal")" ]]; then
            rm -f "$journal" "$run_dir/migration-pending"
            sync -f "$state"
            status rolled-back 'Validation failed; previous configuration restored'
        else
            status blocked 'Rollback incomplete; recovery journal retained'
        fi
    }
    trap rollback EXIT
    trap 'exit 1' TERM INT
    : > "$run_dir/migration-pending"
    status migrating 'Validating the release snapshotter; new builds are paused'
    awk '/^\[/ { oci = ($0 ~ /^\[worker\.oci\][[:space:]]*(#.*)?$/) }
      oci && /^[[:space:]]*snapshotter[[:space:]]*=/ { sub(/"(auto|native)"/, "\"overlayfs\"") } {print}' \
      "$config" > "$config.new"
    chmod 0644 "$config.new"
    sync -f "$config.new"
    mv "$config.new" "$config"
    sync -f "$config_dir"
    systemctl restart verity-buildkit.service
    [[ $(worker) == overlayfs ]]
    probe
    rm -f "$journal" "$run_dir/migration-pending"
    sync -f "$state"
    trap - EXIT TERM INT
    status converged 'overlayfs worker and gVisor RUN verified; native state retained for rollback'
}
source "$bin/native-retire.sh"

case ${1:-} in
    init) init ;;
    recover) recover ;;
    recover-verify) recover_verify ;;
    reconcile)
        if [[ -e $state/native-retirement.json ]]; then native_retire; else
            reconcile; exec 8<&-; exec 7>&-; native_retire
        fi ;;
    drained) drained ;;
    *) echo 'Expected init, recover, recover-verify, drained or reconcile' >&2; exit 2 ;;
esac
