#!/usr/bin/env bash
# Per-step build network for the gVisor builder.
#
# BuildKit's host-network default gives a RUN step no interface of its own, and
# runsc's sandbox network stack then has nothing to route through: every step
# fails to resolve or reach anything. CNI gives each step its own namespace on
# a host bridge with NAT, the way Docker and Podman attach containers.
#
# The one decision that needs care is the subnet. It must not overlap anything
# this host already routes, or builds lose those destinations and the host may
# route them wrongly. So it is chosen here rather than fixed in the product:
#
#   network.sh select   print the subnet to use (stored, revalidated, or new)
#   network.sh apply    select, store, and write the CNI configuration
#
# `apply` runs before every builder start (ExecStartPre), so a route that
# appeared since the last start (a VPN, a new Docker network) moves the builder
# to a free range instead of breaking builds. Steps keep no network state, so a
# move is safe. An administrator can pin a subnet in network.env; a pinned
# subnet that conflicts is reported and refused, never silently replaced.
set -euo pipefail

CONFIG_DIR="${VERITY_BUILDKIT_CONFIG_DIR:-/etc/verity-buildkit}"
STATE_DIR="${VERITY_BUILDKIT_STATE_DIR:-/var/lib/verity-buildkit}"
DAEMON_JSON="${VERITY_DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}"
IP_CMD="${VERITY_BUILDKIT_IP_CMD:-ip}"
DOCKER_CMD="${VERITY_BUILDKIT_DOCKER_CMD:-docker}"
BRIDGE=verity-bk0
NETWORK_ENV="$CONFIG_DIR/network.env"
CONFLIST="$CONFIG_DIR/cni.conflist"

log() { printf 'verity-buildkit-network: %s\n' "$*" >&2; }
die() {
    log "$*"
    exit 1
}

ip_to_int() {
    local IFS=. a b c d
    read -r a b c d <<<"$1"
    printf '%d' $(((a << 24) | (b << 16) | (c << 8) | d))
}
int_to_ip() {
    printf '%d.%d.%d.%d' $((($1 >> 24) & 255)) $((($1 >> 16) & 255)) $((($1 >> 8) & 255)) $(($1 & 255))
}
valid_cidr() {
    [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
    local part
    for part in "${BASH_REMATCH[@]:1:4}"; do ((part <= 255)) || return 1; done
    ((BASH_REMATCH[5] <= 32))
}
# Two prefixes overlap exactly when one contains the other's network address.
overlaps() {
    local a=${1%/*} al=${1#*/} b=${2%/*} bl=${2#*/} len mask
    len=$((al < bl ? al : bl))
    mask=$((len == 0 ? 0 : (0xFFFFFFFF << (32 - len)) & 0xFFFFFFFF))
    (($(($(ip_to_int "$a") & mask)) == $(($(ip_to_int "$b") & mask))))
}

# Prefixes the builder must stay clear of: everything the host routes (except
# its own bridge), every Docker network, the pools Docker will allocate from
# next, and the carrier-grade NAT range VPNs such as Tailscale claim.
occupied() {
    local route
    while read -r route; do
        [[ -n $route ]] || continue
        valid_cidr "$route" && printf '%s\n' "$route"
    done < <("$IP_CMD" -4 -o route show table all 2>/dev/null |
        awk -v bridge="$BRIDGE" '
            { dev = ""; for (i = 1; i < NF; i++) if ($i == "dev") dev = $(i + 1) }
            dev == bridge { next }
            { dst = ($1 ~ /^(local|broadcast|unicast|unreachable|blackhole|prohibit|throw)$/) ? $2 : $1 }
            dst == "default" { next }
            { print (dst ~ /\//) ? dst : dst "/32" }')
    if command -v "$DOCKER_CMD" >/dev/null 2>&1; then
        local ids
        ids="$("$DOCKER_CMD" network ls -q 2>/dev/null || true)"
        if [[ -n $ids ]]; then
            # shellcheck disable=SC2086 # network IDs are single words
            "$DOCKER_CMD" network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' $ids 2>/dev/null |
                tr ' ' '\n' | while read -r route; do valid_cidr "${route:-x}" && printf '%s\n' "$route"; done
        fi
    fi
    local pools=''
    if [[ -f $DAEMON_JSON ]] && command -v jq >/dev/null 2>&1; then
        pools="$(jq -r '(."default-address-pools" // [])[] | .base // empty' "$DAEMON_JSON" 2>/dev/null || true)"
    fi
    if [[ -z $pools ]]; then
        # Docker's built-in defaults when daemon.json configures none.
        pools=$'172.17.0.0/16\n172.18.0.0/15\n172.20.0.0/14\n172.24.0.0/13\n192.168.0.0/16'
    fi
    printf '%s\n' "$pools" | while read -r route; do valid_cidr "${route:-x}" && printf '%s\n' "$route"; done
    printf '%s\n' 100.64.0.0/10
}

conflict_with() {
    local subnet=$1 taken
    while read -r taken; do
        if overlaps "$subnet" "$taken"; then
            printf '%s\n' "$taken"
            return 0
        fi
    done <<<"$OCCUPIED"
    return 1
}

# /24 candidates from two blocks rarely used by LANs, clouds or container tools.
candidates() {
    local block third
    for block in 10.213 10.247; do
        for third in $(seq 0 255); do printf '%s.%d.0/24\n' "$block" "$third"; done
    done
}

stored_value() {
    [[ -f $NETWORK_ENV ]] || return 0
    sed -n "s/^$1=//p" "$NETWORK_ENV" | head -n 1
}

select_subnet() {
    OCCUPIED="$(occupied | sort -u)"
    local pinned stored conflict candidate
    pinned="$(stored_value PINNED_SUBNET)"
    if [[ -n $pinned ]]; then
        valid_cidr "$pinned" || die "PINNED_SUBNET in $NETWORK_ENV is not an IPv4 prefix: $pinned"
        if conflict="$(conflict_with "$pinned")"; then
            die "pinned build subnet $pinned overlaps $conflict on this host; choose another PINNED_SUBNET in $NETWORK_ENV"
        fi
        printf '%s\n' "$pinned"
        return
    fi
    stored="$(stored_value SUBNET)"
    if [[ -n $stored ]] && valid_cidr "$stored"; then
        if ! conflict="$(conflict_with "$stored")"; then
            printf '%s\n' "$stored"
            return
        fi
        log "build subnet $stored now overlaps $conflict; selecting another"
    fi
    while read -r candidate; do
        if ! conflict_with "$candidate" >/dev/null; then
            printf '%s\n' "$candidate"
            return
        fi
    done < <(candidates)
    die 'no free build subnet; set PINNED_SUBNET in '"$NETWORK_ENV"' to a /24 this host does not use'
}

write_atomic() {
    local target=$1 mode=$2 temporary
    temporary="$(mktemp "$target.XXXXXX")"
    cat >"$temporary"
    chmod "$mode" "$temporary"
    mv -f "$temporary" "$target"
}

apply() {
    local subnet network gateway first last pinned
    subnet="$(select_subnet)"
    network=$(ip_to_int "${subnet%/*}")
    [[ ${subnet#*/} -le 29 ]] || die "build subnet $subnet is too small"
    gateway="$(int_to_ip $((network + 1)))"
    first="$(int_to_ip $((network + 2)))"
    last="$(int_to_ip $((network + (1 << (32 - ${subnet#*/})) - 2)))"
    pinned="$(stored_value PINNED_SUBNET)"
    install -d -m 0755 "$CONFIG_DIR"
    install -d -m 0700 "$STATE_DIR/cni"
    {
        printf '# Managed by verity-buildkit. SUBNET is chosen automatically; set PINNED_SUBNET to choose one.\n'
        printf 'SUBNET=%s\n' "$subnet"
        [[ -z $pinned ]] || printf 'PINNED_SUBNET=%s\n' "$pinned"
    } | write_atomic "$NETWORK_ENV" 0644
    # IPv4 only: the bridge carries no IPv6 address or route, so a step has no
    # IPv6 path that the IPv4 NAT and forwarding rules would not cover.
    write_atomic "$CONFLIST" 0644 <<JSON
{
  "cniVersion": "1.0.0",
  "name": "verity-buildkit",
  "plugins": [
    {
      "type": "bridge",
      "bridge": "$BRIDGE",
      "isGateway": true,
      "ipMasq": true,
      "hairpinMode": false,
      "ipam": {
        "type": "host-local",
        "dataDir": "$STATE_DIR/cni",
        "ranges": [[{ "subnet": "$subnet" }]],
        "routes": [{ "dst": "0.0.0.0/0" }]
      }
    },
    { "type": "firewall", "backend": "iptables" }
  ]
}
JSON
    # A bridge left on a previous subnet would keep that route; let the bridge
    # plugin recreate it on the next step.
    if "$IP_CMD" -4 -o addr show dev "$BRIDGE" 2>/dev/null | grep -q . &&
        ! "$IP_CMD" -4 -o addr show dev "$BRIDGE" 2>/dev/null | grep -qF " $gateway/"; then
        "$IP_CMD" link delete "$BRIDGE" 2>/dev/null || true
    fi
    log "build steps use $subnet on $BRIDGE"
}

case "${1:-}" in
    select) select_subnet ;;
    apply) apply ;;
    *) die 'usage: network.sh select|apply' ;;
esac
