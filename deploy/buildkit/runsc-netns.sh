#!/bin/sh
# Keep a build step's CNI interface usable after runsc has run in it.
#
# runsc's sandbox network takes over the interfaces of the namespace it starts
# in and removes their addresses and routes, so the host kernel does not answer
# for the guest. BuildKit then keeps that namespace and hands it to the next
# step, whose runsc finds an interface with no address, configures only
# loopback, and every lookup fails. Record the namespace's IPv4 addresses and
# default route before `run`, and put them back once runsc has exited.
#
# Usage: runsc-netns.sh <runtime> <runtime arguments...>
set -eu
runtime=$1
shift
bundle=
previous=
in_run=false
for argument in "$@"; do
    case "$argument" in
        run) in_run=true ;;
        --bundle=*) [ "$in_run" = true ] && bundle=${argument#--bundle=} ;;
    esac
    if [ "$in_run" = true ] && [ "$previous" = --bundle ]; then bundle=$argument; fi
    previous=$argument
done
netns=
if [ -n "$bundle" ] && [ -f "$bundle/config.json" ]; then
    netns=$(tr -d ' \t\n' < "$bundle/config.json" |
        grep -o '"type":"network","path":"[^"]*"' | head -n 1 | sed 's/.*"path":"//; s/"$//')
fi
if [ -z "$netns" ] || [ ! -e "$netns" ]; then exec "$runtime" "$@"; fi

in_netns() { nsenter --net="$netns" "$@"; }
addresses=$(in_netns ip -4 -o addr show scope global | awk '{ print $2, $4 }')
default_route=$(in_netns ip -4 route show default | awk '$2 == "via" { print $3, $5; exit }')

status=0
"$runtime" "$@" || status=$?

printf '%s\n' "$addresses" | while read -r device address; do
    [ -n "$device" ] || continue
    in_netns ip link set dev "$device" up ||
        echo "runsc-netns: could not bring $device up in $netns" >&2
    in_netns ip addr replace "$address" dev "$device" ||
        echo "runsc-netns: could not restore $address on $device in $netns" >&2
done
if [ -n "$default_route" ]; then
    set -- $default_route
    in_netns ip route replace default via "$1" dev "$2" ||
        echo "runsc-netns: could not restore the default route in $netns" >&2
fi
exit "$status"
