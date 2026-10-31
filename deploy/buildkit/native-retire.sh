#!/usr/bin/env bash
# Sourced by the release-owned snapshotter reconciler; never accepts a supplied path or command.
native_retire() (
    set -euo pipefail
    local target=$root/runc-native quarantine=$root/.verity-native-retired record=$state/native-retirement.json
    local blockers='[]' allocated=null overlay_bytes=null freed=null before after temp nonce ids id metadata identity evidence mountlist
    blocker() { blockers=$(jq -cn --argjson old "$blockers" --arg reason "$1" '$old + [$reason]'); }
    report() {
        temp=$(mktemp "$run_dir/.native-result.XXXXXX")
        jq -cn --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" --arg path "$target" \
            --arg state "$1" --argjson allocatedBytes "$allocated" --argjson overlayAllocatedBytes "$overlay_bytes" --argjson filesystemFreedBytes "$freed" --argjson blockers "$blockers" \
            '{version:1,observedAt:$observedAt,path:$path,dryRun:false,eligible:($blockers|length==0),state:$state,allocatedBytes:$allocatedBytes,overlayAllocatedBytes:$overlayAllocatedBytes,reclaimableBytes:null,filesystemFreedBytes:$filesystemFreedBytes,blockers:$blockers}' > "$temp"
        chmod 0644 "$temp"; sync -f "$temp"; mv -f "$temp" "$run_dir/native-retirement.json"
    }
    trap 'blocker native-retirement-operation-failed; report blocked' ERR
    # Share the install/migration lock, then fence every admission for the entire transaction.
    exec 6>"$state/lock"; flock -n 6 || { blocker maintenance-busy; report deferred; exit 0; }
    exec 5<"$run_dir/build-admission.lock"; flock -w 5 5 || { blocker builder-admission-busy; report deferred; exit 0; }
    if [[ -e $record ]]; then
        # A crash may have stopped the daemon after journalling. Start only the
        # already-selected overlay worker; the pending flag continues to fence clients.
        if [[ -f $record && ! -L $record && $(selected) == overlayfs && ! -e $journal ]] &&
           jq -e --arg path "$target" --arg quarantine "$quarantine" '.version == 1 and .path == $path and .quarantine == $quarantine' "$record" >/dev/null &&
           [[ $root == /var/lib/verity-buildkit && ! -L $target && ! -L $quarantine ]]; then
            timeout 30 systemctl start verity-buildkit.service
        fi
    fi
    [[ $root == /var/lib/verity-buildkit && $(realpath -e -- "$root") == "$root" && ! -L $target && ! -L $quarantine ]] || blocker unsupported-or-symlinked-state-root
    [[ ! -e $journal ]] || blocker migration-recovery-pending
    [[ $(selected) == overlayfs && $(worker) == overlayfs ]] || blocker overlay-worker-not-verified
    clients_compatible || blocker unknown-builder-consumers
    [[ -z $(find "$run_dir/leases" -mindepth 1 -maxdepth 1 -print -quit) ]] || blocker unresolved-runtime-leases
    ctl du --format '{{json .}}' | jq -se 'length == 1 and (.[0] | if . == null then true else type == "array" and all(.[]; .inUse == false) end)' >/dev/null || blocker builder-activity-not-excluded
    [[ ! -e $run_dir/migration-pending || -f $record ]] || blocker maintenance-recovery-pending
    if [[ $root == /var/lib/verity-buildkit && -d $root/runc-overlayfs && ! -L $root/runc-overlayfs && $(realpath -e -- "$root/runc-overlayfs") == "$root/runc-overlayfs" ]]; then
        overlay_bytes=$(timeout 5 du -sx -B1 -- "$root/runc-overlayfs" | awk '{print $1}') || overlay_bytes=null
    fi
    # Check the complete mount table, including descendants. Failure is not absence.
    mountlist=$(timeout 5 findmnt --json --output TARGET) || { blocker mount-inventory-unavailable; mountlist='{}'; }
    jq -e --arg target "$target" --arg quarantine "$quarantine" '
      .filesystems | type == "array"' <<< "$mountlist" >/dev/null || blocker mount-inventory-invalid
    if jq -e --arg target "$target" --arg quarantine "$quarantine" '
      [.. | objects | .target? // empty] | any(. == $target or startswith($target + "/") or . == $quarantine or startswith($quarantine + "/"))' <<< "$mountlist" >/dev/null; then blocker native-state-is-mounted; fi
    if [[ -e $record ]]; then
        # Recovery may only continue the exact release-owned transaction.
        [[ -f $record && ! -L $record ]] && jq -e --arg path "$target" --arg quarantine "$quarantine" \
          '.version == 1 and .path == $path and .quarantine == $quarantine' "$record" >/dev/null || blocker invalid-retirement-journal
    elif [[ -e $quarantine ]]; then blocker unknown-quarantine; fi
    if [[ ! -e $target && ! -e $quarantine ]]; then
        if [[ $blockers != '[]' ]]; then report deferred; exit 0; fi
        if [[ -e $record ]]; then
            # Deletion may have completed just before a crash. Verify service
            # operation before clearing the durable admission blocker.
            probe || { blocker overlay-verification-failed; report blocked; exit 1; }
            rm -f "$record" "$run_dir/migration-pending"; sync -f "$state"
        fi
        if [[ -f $state/native-retirement-completed.json ]]; then
            temp=$(mktemp "$run_dir/.native-result.XXXXXX")
            jq --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" --argjson overlayAllocatedBytes "$overlay_bytes" \
              '.lastCompletedAt = .observedAt | .observedAt = $observedAt | .overlayAllocatedBytes = $overlayAllocatedBytes' "$state/native-retirement-completed.json" > "$temp"
            chmod 0644 "$temp"; mv -f "$temp" "$run_dir/native-retirement.json"
        else report absent; fi
        exit 0
    fi
    if [[ $blockers != '[]' ]]; then report deferred; exit 0; fi
    # A root-owned fresh challenge binds all evidence to this exclusive admission window.
    nonce=$(cat /proc/sys/kernel/random/uuid)
    temp=$(mktemp "$run_dir/.native-challenge.XXXXXX")
    jq -cn --arg nonce "$nonce" --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" '{version:1,nonce:$nonce,observedAt:$observedAt}' > "$temp"
    chmod 0644 "$temp"; mv -f "$temp" "$run_dir/native-challenge.json"
    # Include stopped socket consumers: without an independent inventory they cannot
    # prove old reservations safe. Keeping them is preferable to silently forgetting one.
    ids=$(timeout 10 docker ps -aq) || { blocker consumer-inventory-unavailable; ids=; }
    local seen=" " consumers=0
    for id in $ids; do
        metadata=$(timeout 5 docker inspect --format '{"mounts":{{json .Mounts}},"identity":{{json .Config.Hostname}},"running":{{json .State.Running}}}' "$id") || { blocker consumer-inspection-failed; continue; }
        jq -e '.mounts | type == "array"' <<< "$metadata" >/dev/null || { blocker consumer-inspection-invalid; continue; }
        if ! jq -e --arg socket "$run_dir" '.mounts | any(.Source as $s | $s == "/" or $s == $socket or $s == ($socket + "/buildkitd.sock") or ($socket | startswith($s + "/")))' <<< "$metadata" >/dev/null; then continue; fi
        identity=$(jq -er '.identity | select(test("^[a-zA-Z0-9-]{1,64}$"))' <<< "$metadata") || { blocker consumer-identity-invalid; continue; }
        jq -e '.running == true' <<< "$metadata" >/dev/null || { blocker stopped-builder-consumer-needs-reservation-evidence; continue; }
        if [[ $seen == *" $identity "* ]]; then blocker duplicate-consumer-identity; continue; fi
        seen+="$identity "; consumers=$((consumers + 1))
        evidence=$run_dir/reclamation-evidence/$identity.json
        local valid=false
        for retry in 1 2 3 4 5; do
            if [[ -f $evidence && ! -L $evidence ]] && jq -e --arg nonce "$nonce" --arg identity "$identity" \
                '.version == 1 and .nonce == $nonce and .identity == $identity and .empty == true' "$evidence" >/dev/null 2>&1; then valid=true; break; fi
            sleep 1
        done
        [[ $valid == true ]] || blocker persistent-reservations-not-proven-empty
    done
    [[ $consumers -gt 0 ]] || blocker independent-server-evidence-unavailable
    rm -f "$run_dir/native-challenge.json"
    if [[ $blockers != '[]' ]]; then report deferred; exit 0; fi
    # Recovery cannot select native after its state has been retired. This durable
    # marker is also checked before any installer restart or migration rollback.
    : > "$state/native-retired"
    sync -f "$state/native-retired"
    if [[ ! -e $record ]]; then
        temp=$(mktemp "$state/.native-journal.XXXXXX")
        jq -cn --arg path "$target" --arg quarantine "$quarantine" '{version:1,path:$path,quarantine:$quarantine}' > "$temp"
        sync -f "$temp"; mv -f "$temp" "$record"; sync -f "$state"
    fi
    : > "$run_dir/migration-pending"
    # No daemon retains descriptors to the native directory across its rename.
    timeout 30 systemctl stop verity-buildkit.service
    if [[ -d $target ]]; then
        [[ $(realpath -e -- "$target") == "$target" && ! -e $quarantine ]] || { blocker native-path-changed; report blocked; exit 1; }
        mv -- "$target" "$quarantine"; sync -f "$root"
    fi
    timeout 30 systemctl start verity-buildkit.service
    [[ $(worker) == overlayfs ]] && probe || { blocker overlay-verification-failed; report blocked; exit 1; }
    [[ -d $quarantine && ! -L $quarantine && $(realpath -e -- "$quarantine") == "$quarantine" ]] || { blocker unsafe-quarantine; report blocked; exit 1; }
    mountlist=$(timeout 5 findmnt --json --output TARGET)
    jq -e --arg quarantine "$quarantine" '.filesystems | type == "array"' <<< "$mountlist" >/dev/null
    if jq -e --arg quarantine "$quarantine" '[.. | objects | .target? // empty] | any(. == $quarantine or startswith($quarantine + "/"))' <<< "$mountlist" >/dev/null; then blocker quarantine-is-mounted; report blocked; exit 1; fi
    allocated=$(timeout 15 du -sx -B1 -- "$quarantine" | awk '{print $1}')
    [[ $allocated =~ ^[0-9]+$ ]] || { blocker allocated-bytes-unavailable; report blocked; exit 1; }
    before=$(df -B1 --output=avail "$root" | tail -n 1 | tr -d ' ')
    timeout 120 rm -rf --one-file-system -- "$quarantine"
    [[ ! -e $quarantine ]] || { blocker retirement-incomplete; report blocked; exit 1; }
    after=$(df -B1 --output=avail "$root" | tail -n 1 | tr -d ' ')
    if [[ $before =~ ^[0-9]+$ && $after =~ ^[0-9]+$ ]]; then freed=$((after > before ? after - before : 0)); fi
    sync -f "$root"
    rm -f "$record" "$run_dir/migration-pending"; sync -f "$state"
    echo "Retired native BuildKit directory $target: allocatedBytes=$allocated filesystemFreedBytes=$freed" >&2
    report completed
    cp -- "$run_dir/native-retirement.json" "$state/native-retirement-completed.json"
    chmod 0600 "$state/native-retirement-completed.json"; sync -f "$state/native-retirement-completed.json"
)
