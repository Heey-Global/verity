#!/usr/bin/env bash
# Disposable fixture only: use the installed production Runner stack unchanged.
set -euo pipefail
test "${PROJECT_EGRESS_DISPOSABLE:-}" = yes
setpriv --reuid=1000 --regid=1000 --clear-groups \
  python3 -u /probe/startup-emitter.py &
export VERITY_RUNNER_FOREGROUND=1
exec /usr/local/bin/verity-runner-stack-start
