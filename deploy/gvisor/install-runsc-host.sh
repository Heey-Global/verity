#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$script_dir/versions.env"

if [[ ${EUID} -ne 0 ]]; then
  echo "install-runsc-host.sh must run as root" >&2
  exit 1
fi
for tool in chmod cp curl dockerd jq rm sha512sum install systemctl; do
  command -v "$tool" >/dev/null || { echo "missing required host tool: $tool" >&2; exit 1; }
done

case "$(uname -m)" in
  x86_64) arch=x86_64; checksum=$RUNSC_SHA512_X86_64 ;;
  aarch64|arm64) arch=aarch64; checksum=$RUNSC_SHA512_AARCH64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

install_dir="/opt/verity/runsc/$RUNSC_RELEASE"
install_path="$install_dir/runsc"
download="$(mktemp)"
install --directory --mode=0755 /etc/docker
daemon_tmp="$(mktemp /etc/docker/daemon.json.verity.XXXXXX)"
daemon_backup="$(mktemp)"
trap 'rm -f "$download" "$daemon_tmp" "$daemon_backup"' EXIT

curl --fail --silent --show-error --location \
  "https://storage.googleapis.com/gvisor/releases/release/${RUNSC_RELEASE#release-}/$arch/runsc" \
  --output "$download"
printf '%s  %s\n' "$checksum" "$download" | sha512sum --check --status
chmod 0755 "$download"
version_output="$("$download" --version)"
if [[ ${version_output%%$'\n'*} != "runsc version $RUNSC_RELEASE" ]]; then
  echo "downloaded runsc version does not match $RUNSC_RELEASE" >&2
  exit 1
fi
install --directory --mode=0755 "$install_dir"
install --mode=0755 "$download" "$install_path"

daemon_file=/etc/docker/daemon.json
had_daemon=false
if [[ -f $daemon_file ]]; then
  had_daemon=true
  cp --preserve=mode,ownership,timestamps "$daemon_file" "$daemon_backup"
  jq --arg path "$install_path" \
    '.runtimes = (.runtimes // {}) | .runtimes.runsc = {path: $path, runtimeArgs: ["--platform=systrap", "--network=none"]}' \
    "$daemon_file" >"$daemon_tmp"
else
  jq --null-input --arg path "$install_path" \
    '{runtimes: {runsc: {path: $path, runtimeArgs: ["--platform=systrap", "--network=none"]}}}' \
    >"$daemon_tmp"
fi
dockerd --validate --config-file "$daemon_tmp"
install --mode=0644 "$daemon_tmp" "$daemon_file"
if ! systemctl reload docker; then
  echo "Docker reload failed; restoring previous daemon configuration" >&2
  if [[ $had_daemon == true ]]; then
    install --mode=0644 "$daemon_backup" "$daemon_file"
  else
    rm -f "$daemon_file"
  fi
  systemctl reload docker || true
  exit 1
fi

echo "installed $RUNSC_RELEASE at $install_path and registered Docker runtime runsc"
