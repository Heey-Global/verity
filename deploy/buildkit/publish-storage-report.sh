#!/usr/bin/env bash
# Publishes filesystem facts only. Does not prune, start builds or enumerate data files.
set -euo pipefail
state_dir=${VERITY_HOST_DIAGNOSTIC_DIR:-/var/lib/verity/host-diagnostics}
[[ ! -L $state_dir ]] || exit 1
install -d -m 0755 "$state_dir"
export_root=
containerd_root=/.verity-storage-unavailable
project_root=
volume=verity-data
policy=${VERITY_BUILD_STORAGE_ROOTS:-/etc/verity-buildkit/storage-roots.conf}
if [[ -e $policy ]]; then
    [[ -f $policy && ! -L $policy ]] || exit 1
    while IFS= read -r line || [[ -n $line ]]; do
        [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
        case $line in
            version=1) ;;
            dataVolume=*) volume=${line#*=}; [[ $volume =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 1 ;;
            containerdRoot=/*) containerd_root=${line#*=} ;;
            exportRoot=/*) export_root=${line#*=} ;;
            projectRoot=/*) project_root=${line#*=} ;;
            *) echo 'Invalid build storage roots configuration' >&2; exit 1 ;;
        esac
    done < "$policy"
fi
docker_root=$(timeout 5s docker info --format '{{.DockerRootDir}}' 2>/dev/null) || docker_root=
# Unconfigured, the containerd root is read from the running containerd that
# serves the address Docker reports. That daemon's own command line decides:
# --root and --address override its configuration file, and --config names
# that file. Only root's processes count, and nothing a process names is ever
# executed; the file is read as data, with containerd's built-in defaults where
# it is silent. A configuration file alone can disagree with a daemon started
# with overrides, and another filesystem would then be measured instead.
# Anything that does not resolve to exactly one daemon stays unavailable.
proc=${VERITY_PROC_ROOT:-/proc}
default_config=${VERITY_CONTAINERD_CONFIG:-/etc/containerd/config.toml}
# Prints "<address> <root>" for one running root-owned containerd, or nothing.
containerd_effective() {
    local pid=$1 argument value flag= config=$default_config root= address= file=
    local -a arguments=()
    [[ $(awk '/^Uid:/ { print $2; exit }' "$proc/$pid/status" 2>/dev/null) == 0 ]] || return 0
    mapfile -d '' -t arguments < "$proc/$pid/cmdline" 2>/dev/null || return 0
    for argument in "${arguments[@]:1}"; do
        if [[ -n $flag ]]; then value=$argument
        else
            case $argument in
                --config=*|--root=*|--address=*) flag=${argument%%=*} value=${argument#*=} ;;
                --config|-c|--root|--address|-a) flag=$argument; continue ;;
                *) continue ;;
            esac
        fi
        case $flag in
            --config|-c) config=$value ;;
            --root) root=$value ;;
            --address|-a) address=$value ;;
        esac
        flag=
    done
    if [[ -f $config && ! -L $config ]]; then file=$(head -c 262144 -- "$config"); fi
    # containerd 1.x writes [grpc] and double quotes; 2.x the grpc plugin table and single quotes.
    [[ -n $address ]] || address=$(awk '/^[[:space:]]*\[/ {
            grpc = ($0 ~ /^[[:space:]]*\[grpc\][[:space:]]*$/ ||
                    $0 ~ /^[[:space:]]*\[plugins\.["\x27]io\.containerd\.server\.v1\.grpc["\x27]\][[:space:]]*$/) }
        grpc && /^[[:space:]]*address[[:space:]]*=/ { sub(/^[^"\x27]*["\x27]/, ""); sub(/["\x27].*$/, ""); print; exit }' <<< "$file")
    [[ -n $root ]] || root=$(sed -nE "s/^root[[:space:]]*=[[:space:]]*[\"']([/][^\"']*)[\"'][[:space:]]*$/\1/p" <<< "$file" | head -n 1)
    # containerd's compiled-in defaults, the same in 1.x and 2.x.
    printf '%s %s\n' "${address:-/run/containerd/containerd.sock}" "${root:-/var/lib/containerd}"
}
if [[ $containerd_root == /.verity-storage-unavailable ]]; then
    docker_containerd=$(timeout 5s docker info --format '{{.Containerd.Address}}' 2>/dev/null) || docker_containerd=
    serving=()
    if [[ -n $docker_containerd ]]; then
        for comm in "$proc"/[0-9]*/comm; do
            [[ $(cat "$comm" 2>/dev/null) == containerd ]] || continue
            pid=${comm%/comm}
            read -r address root < <(containerd_effective "${pid##*/}") || continue
            [[ $address == "$docker_containerd" ]] && serving+=("$root")
        done
    fi
    # Count every daemon claiming the address before judging its root: dropping
    # an unresolved one first would make the other look unique.
    if ((${#serving[@]} == 1)) && [[ ${serving[0]} == /* && -d ${serving[0]} ]]; then
        containerd_root=${serving[0]}
    fi
fi
if [[ -z $export_root ]]; then
    export_root=$(timeout 5s docker volume inspect --format '{{.Mountpoint}}' "$volume" 2>/dev/null) || export_root=
fi
[[ $docker_root == /* ]] || docker_root=/.verity-storage-unavailable
[[ $export_root == /* ]] || export_root=/.verity-storage-unavailable
[[ -n $project_root ]] || project_root=$export_root
temp=$(mktemp "$state_dir/.storage.XXXXXX")
trap 'rm -f "$temp"' EXIT
# The installed config currently supports the dedicated service's fixed state
# root. Never infer the worker snapshotter from this path or from Docker info.
VERITY_STORAGE_REPORT_USAGE=0 "${VERITY_BUILDKIT_LIBEXEC:-/usr/local/libexec/verity-buildkit}/storage-report.sh" \
    /var/lib/verity-buildkit "$docker_root" "$containerd_root" "$export_root" "$project_root" > "$temp"
chmod 0644 "$temp"
mv -f "$temp" "$state_dir/storage.json"
