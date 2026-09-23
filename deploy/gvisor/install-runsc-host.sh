#!/usr/bin/env bash
# Install the pinned gVisor runtime and register both Docker runtimes Verity needs (`runsc` for
# Secret jobs, `runsc-project` for project Sandboxes). One implementation for every path that
# does this — `verity-install`, the managed Updater's host requests, and this manual entry
# point — lives in deploy/host/verity-host-runtime; see it for what is changed and how a
# reload is kept from restarting containers.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ${EUID} -ne 0 ]]; then
  echo "install-runsc-host.sh must run as root" >&2
  exit 1
fi
exec "$script_dir/../host/verity-host-runtime" apply-pins "$script_dir/versions.env"
