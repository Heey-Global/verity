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
# Unconfigured, the containerd root is read from the containerd Docker actually
# uses: the system containerd's own configuration counts only when its socket is
# the address Docker reports. Any other arrangement stays unavailable, which
# blocks builds, rather than naming a directory that may hold nothing.
if [[ $containerd_root == /.verity-storage-unavailable ]]; then
    docker_containerd=$(timeout 5s docker info --format '{{.Containerd.Address}}' 2>/dev/null) || docker_containerd=
    containerd_config=$(timeout 5s containerd config dump 2>/dev/null) || containerd_config=
    # containerd 1.x writes [grpc] and double quotes; 2.x the grpc plugin table and single quotes.
    containerd_address=$(awk '/^[[:space:]]*\[/ {
            grpc = ($0 ~ /^[[:space:]]*\[grpc\][[:space:]]*$/ ||
                    $0 ~ /^[[:space:]]*\[plugins\.["\x27]io\.containerd\.server\.v1\.grpc["\x27]\][[:space:]]*$/) }
        grpc && /^[[:space:]]*address[[:space:]]*=/ { sub(/^[^"\x27]*["\x27]/, ""); sub(/["\x27].*$/, ""); print; exit }' <<< "$containerd_config")
    configured_root=$(sed -nE "s/^root[[:space:]]*=[[:space:]]*[\"']([/][^\"']*)[\"'][[:space:]]*$/\1/p" <<< "$containerd_config" | head -n 1)
    if [[ -n $docker_containerd && $docker_containerd == "$containerd_address" && -n $configured_root && -d $configured_root ]]; then
        containerd_root=$configured_root
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
