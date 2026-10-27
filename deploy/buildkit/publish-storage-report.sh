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
policy=/etc/verity-buildkit/storage-roots.conf
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
VERITY_STORAGE_REPORT_USAGE=0 /usr/local/libexec/verity-buildkit/storage-report.sh \
    /var/lib/verity-buildkit "$docker_root" "$containerd_root" "$export_root" "$project_root" > "$temp"
chmod 0644 "$temp"
mv -f "$temp" "$state_dir/storage.json"
