#!/usr/bin/env bash
# Keep heap aborts from producing core dumps without interpreting worker arguments.
set -euo pipefail
ulimit -c 0
exec "$@"
