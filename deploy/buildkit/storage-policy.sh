#!/usr/bin/env bash
# Render version 1 of the storage policy without executing host configuration.
set -euo pipefail
template=$1
previous=$2
policy=$3
gid=$4
reserved=1
budget=10
free=5
age=72
version=1
if [[ -e $policy ]]; then
    [[ -f $policy && ! -L $policy ]] || { echo 'Invalid builder storage policy file' >&2; exit 1; }
    while IFS= read -r line || [[ -n $line ]]; do
        [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
        [[ $line =~ ^(version|reservedGiB|budgetGiB|freeGiB|ageHours)=([0-9]+)$ ]] || {
            echo 'Invalid builder storage policy: expected key=integer' >&2; exit 1;
        }
        value=${BASH_REMATCH[2]}
        [[ ${#value} -le 6 && $value != 0* ]] || { echo 'Invalid builder storage policy value' >&2; exit 1; }
        case ${BASH_REMATCH[1]} in
            version) version=$value ;;
            reservedGiB) reserved=$value ;;
            budgetGiB) budget=$value ;;
            freeGiB) free=$value ;;
            ageHours) age=$value ;;
        esac
    done < "$policy"
fi
[[ $version == 1 && $reserved -le $budget && $budget -le 65536 && $free -le 65536 && $age -le 8760 ]] || {
    echo 'Invalid builder storage policy limits or version' >&2; exit 1;
}
[[ $gid =~ ^[0-9]+$ && $gid -gt 0 && $gid -lt 65535 ]] || exit 1
# An update must not silently choose a different snapshotter. Only the OCI
# section counts: a containerd setting does not identify this worker.
snapshotter=auto
if [[ -f $previous ]]; then
    previous_root=$(awk '/^\[/ { exit } /^[[:space:]]*root[[:space:]]*=/ { print }' "$previous")
    if [[ -z $previous_root ]]; then
        echo 'Cannot establish existing BuildKit state root; explicit maintenance required' >&2
        exit 1
    fi
    if [[ ! $previous_root =~ ^[[:space:]]*root[[:space:]]*=[[:space:]]*\"/var/lib/verity-buildkit\"[[:space:]]*(#.*)?$ ]]; then
        echo 'Unsupported existing BuildKit state root; explicit maintenance required' >&2
        exit 1
    fi
    selected=$(awk '
        /^\[/ { oci = ($0 ~ /^\[worker\.oci\][[:space:]]*(#.*)?$/) }
        oci && /^[[:space:]]*snapshotter[[:space:]]*=/ { print }
    ' "$previous")
    if [[ -n $selected ]]; then
        [[ $selected =~ ^[[:space:]]*snapshotter[[:space:]]*=[[:space:]]*\"(auto|native|overlayfs)\"[[:space:]]*(#.*)?$ ]] || {
            echo 'Cannot preserve existing OCI snapshotter; check buildkitd.toml' >&2; exit 1;
        }
        snapshotter=${BASH_REMATCH[1]}
    else
        echo 'Cannot establish existing OCI snapshotter; explicit maintenance required' >&2
        exit 1
    fi
fi
sed -e "s/^  gid = 1102$/  gid = $gid/" \
    -e "s/^  snapshotter = .*/  snapshotter = \"$snapshotter\"/" \
    -e "s/^  reservedSpace = .*/  reservedSpace = \"$((reserved * 1024 ** 3))\"/" \
    -e "s/^  maxUsedSpace = .*/  maxUsedSpace = \"$((budget * 1024 ** 3))\"/" \
    -e "s/^  minFreeSpace = .*/  minFreeSpace = \"$((free * 1024 ** 3))\"/" "$template"
# Age is an eligibility threshold, not a promise that every old entry is
# deleted. BuildKit owns reference safety and may retain active/shared records.
cat <<EOF

[[worker.oci.gcpolicy]]
  keepDuration = "${age}h"
  reservedSpace = "$((reserved * 1024 ** 3))"
  maxUsedSpace = "$((reserved * 1024 ** 3))"

[[worker.oci.gcpolicy]]
  all = true
  reservedSpace = "$((reserved * 1024 ** 3))"
  maxUsedSpace = "$((budget * 1024 ** 3))"
  minFreeSpace = "$((free * 1024 ** 3))"
EOF
