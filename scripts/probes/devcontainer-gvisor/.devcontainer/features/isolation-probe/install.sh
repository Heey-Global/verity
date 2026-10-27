#!/bin/sh
set -eu
printf 'verity-probe: feature-install\n'
cat /proc/version
dmesg || true
printf 'feature-install\n' > /verity-feature-probe
