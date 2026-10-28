#!/bin/sh
# Trusted worker-side instrumentation; never mounted into the build guest.
set -eu
printf '%s\n' "$*" >> /evidence/invocations.log
bundle=
previous=
for argument in "$@"; do
    if [ "$previous" = --bundle ] || [ "$previous" = -b ]; then bundle=$argument; fi
    case "$argument" in --bundle=*) bundle=${argument#--bundle=} ;; esac
    previous=$argument
done
if [ -n "$bundle" ] && [ -f "$bundle/config.json" ]; then
    record=$(mktemp /evidence/bundles/oci.XXXXXX)
    cp "$bundle/config.json" "$record"
fi
# BuildKit must snapshot the writes; runsc's default root overlay discards them.
exec /usr/local/bin/runsc-buildkit-args /usr/local/bin/runsc-real --platform=systrap --network=sandbox --overlay2=none \
    --debug --debug-log=/evidence/runsc/ "$@"
