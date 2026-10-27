#!/usr/bin/env bash
# Read-only, bounded host collection. Paths must be established by the caller;
# container-visible /tmp and Docker's storage driver do not identify host roots.
set -euo pipefail
[[ $# == 5 ]] || {
    echo 'Usage: storage-report.sh BUILDKIT_ROOT DOCKER_ROOT CONTAINERD_ROOT EXPORT_ROOT PROJECT_ROOT' >&2
    exit 2
}
for path in "$@"; do
    [[ $path == /* && $path != *$'\n'* ]] || { echo 'Storage roots must be absolute paths' >&2; exit 2; }
done
root_report() {
    local kind=$1 path=$2 stats device mount usage=null sampled_at
    sampled_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # Each missing/unreadable root is explicit. Never substitute another mount.
    if [[ ! -d $path ]] || ! stats=$(timeout 3s stat -f -c '%i %S %b %a %c %d' -- "$path") || \
       ! device=$(timeout 3s stat -L -c '%d' -- "$path"); then
        jq -n --arg kind "$kind" --arg path "$path" '{kind:$kind,path:$path,state:"unavailable"}'
        return
    fi
    mount=$(timeout 3s findmnt --json --target "$path" --output TARGET,SOURCE,FSTYPE,MAJ:MIN 2>/dev/null) || mount=null
    # Recursive accounting is opt-in and cannot stall collection indefinitely.
    # A timeout means unknown, never zero. These totals may overlap other roots.
    if [[ ${VERITY_STORAGE_REPORT_USAGE:-0} == 1 ]]; then
        measured=$(timeout 10s du -sx -B1 -- "$path" 2>/dev/null) || measured=
        if [[ $measured =~ ^([0-9]+)[[:space:]] ]]; then usage=${BASH_REMATCH[1]}; fi
    fi
    read -r fsid block total available inodes free_inodes <<< "$stats"
    jq -n --arg observedAt "$sampled_at" --arg kind "$kind" --arg path "$path" --arg fsid "$fsid" --arg device "$device" \
        --argjson block "$block" --argjson total "$total" --argjson available "$available" \
        --argjson inodes "$inodes" --argjson freeInodes "$free_inodes" --argjson mount "$mount" \
        --argjson physicalTreeBytes "$usage" \
        '{kind:$kind,path:$path,state:"available",observedAt:$observedAt,filesystemId:($device+":"+$fsid),
          totalBytes:($block*$total),availableBytes:($block*$available),
          totalInodes:$inodes,freeInodes:$freeInodes,mount:$mount,physicalTreeBytes:$physicalTreeBytes}'
}
roots=$( { root_report buildkit "$1"; root_report docker "$2"; root_report containerd "$3"; root_report export "$4"; root_report project "$5"; } | jq -s .)
# This is current worker evidence from the daemon, not Docker info or a stale
# directory name. Missing client, timeout or unavailable daemon stays unknown.
workers=null
worker_state=unavailable
client=${VERITY_BUILDCTL:-/usr/local/libexec/verity-buildkit/buildctl}
if [[ -x $client ]]; then
    if workers=$(timeout 5s "$client" --addr unix:///run/verity-buildkit/buildkitd.sock \
        debug workers --format '{{json .}}' | head -c 262145) && \
        [[ ${#workers} -le 262144 ]] && workers=$(jq -e 'if type == "array" then . else error("invalid workers") end' <<< "$workers"); then
        worker_state=available
    else
        workers=null
    fi
fi
jq -n --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson roots "$roots" \
    --arg workerState "$worker_state" --argjson workers "$workers" \
    '{schemaVersion:1,observedAt:$observedAt,roots:$roots,
      accounting:"Root tree totals may overlap. Do not sum them or add logical cache/image sizes to them.",
      worker:{state:$workerState,records:$workers},activeSolves:{state:"unavailable"}}'
