#!/usr/bin/env bash
# Keep the actual managed entrypoint; emit from the first fixture instructions.
set -euo pipefail
setpriv --reuid=1000 --regid=1000 --clear-groups python3 -u /opt/verity-boot/startup-emitter.py &
exec /usr/local/bin/verity-agent-run
