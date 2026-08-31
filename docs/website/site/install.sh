#!/usr/bin/env bash
# Public one-command Verity bootstrap, served as https://verity.build/install.sh.
set -euo pipefail

IMAGE_REPOSITORY=ghcr.io/heey-global/verity/verity-server
# VARITY_IMAGE_TAG is a temporary compatibility fallback for bootstrap
# automation created before the product spelling was corrected to Verity.
IMAGE_TAG=${VERITY_IMAGE_TAG:-${VARITY_IMAGE_TAG:-latest}}
INSTALL_MISSING=0
PREFLIGHT_ONLY=0

die() {
  printf 'verity-install: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [bootstrap options] [verity-install options]

Bootstrap options:
  --preflight         Check every host prerequisite and exit without changing anything.
  --install-missing   Install missing basic system tools (tar, flock, and OpenSSL) with the host
                      package manager. Docker and Compose are never installed automatically.
  -h, --help          Show this help.

All other options are passed to the release-matched verity-install.
EOF
}

installer_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --preflight) PREFLIGHT_ONLY=1; shift ;;
    --install-missing) INSTALL_MISSING=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) installer_args+=("$1"); shift ;;
  esac
done

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

preflight_errors=()
missing_system_tools=()

preflight_error() { preflight_errors+=("$1"); }

run_preflight() {
  preflight_errors=()
  missing_system_tools=()

  [ "$(uname -s 2>/dev/null || true)" = Linux ] ||
    preflight_error 'a Linux host is required'
  case "$(uname -m 2>/dev/null || true)" in
    x86_64|amd64) ;;
    *) preflight_error "amd64/x86_64 is required (found $(uname -m 2>/dev/null || printf unknown))" ;;
  esac

  for tool in tar flock openssl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing_system_tools+=("$tool")
      preflight_error "$tool is required"
    fi
  done
  for tool in readlink stat awk grep mktemp; do
    command -v "$tool" >/dev/null 2>&1 || preflight_error "$tool is required"
  done

  local can_elevate=1
  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    preflight_error 'root access is required; install sudo or run this command as root'
    can_elevate=0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    preflight_error 'Docker 25 or newer is required: https://docs.docker.com/engine/install/'
  elif [ "$can_elevate" -eq 1 ]; then
    local docker_server_version docker_server_major
    if ! as_root docker version >/dev/null 2>&1; then
      preflight_error 'cannot reach the root Docker daemon'
    elif ! docker_server_version=$(as_root docker version --format '{{.Server.Version}}' 2>/dev/null); then
      preflight_error 'cannot determine the Docker server version'
    else
      docker_server_major=${docker_server_version%%.*}
      case "$docker_server_major" in
        ''|*[!0-9]*) preflight_error "cannot parse Docker server version: $docker_server_version" ;;
        *) [ "$docker_server_major" -ge 25 ] || preflight_error "Docker 25 or newer is required (found $docker_server_version)" ;;
      esac
      as_root docker compose version >/dev/null 2>&1 ||
        preflight_error 'the Docker Compose v2 plugin is required'
    fi
  fi

  if command -v readlink >/dev/null 2>&1 && command -v stat >/dev/null 2>&1; then
    [ "$(readlink -f /opt 2>/dev/null || true)" = /opt ] ||
      preflight_error '/opt must exist and must not resolve through a symlink'
    [ "$(stat -c '%u' /opt 2>/dev/null || true)" = 0 ] ||
      preflight_error '/opt must be owned by root'
    local opt_mode
    opt_mode=$(printf '%04d' "$(stat -c '%a' /opt 2>/dev/null || printf 777)")
    case "${opt_mode#??}" in
      *[2367]*) preflight_error '/opt must not be writable by group or other users' ;;
    esac
  fi
}

install_system_tools() {
  [ "${#missing_system_tools[@]}" -gt 0 ] || return 0
  local packages=()
  for tool in "${missing_system_tools[@]}"; do
    case "$tool" in
      tar) packages+=(tar) ;;
      flock) packages+=(util-linux) ;;
      openssl) packages+=(openssl) ;;
    esac
  done

  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update
    as_root apt-get install -y "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y "${packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y "${packages[@]}"
  elif command -v zypper >/dev/null 2>&1; then
    as_root zypper --non-interactive install "${packages[@]}"
  else
    die "cannot install ${missing_system_tools[*]} automatically; no supported package manager was found"
  fi
}

run_preflight
if [ "$INSTALL_MISSING" -eq 1 ] && [ "${#missing_system_tools[@]}" -gt 0 ]; then
  if [ "$(id -u)" -eq 0 ] || command -v sudo >/dev/null 2>&1; then
    printf 'verity-install: installing missing system tools: %s\n' "${missing_system_tools[*]}"
    install_system_tools
    run_preflight
  fi
fi

if [ "${#preflight_errors[@]}" -gt 0 ]; then
  printf 'verity-install: preflight failed (%d issues):\n' "${#preflight_errors[@]}" >&2
  printf '  - %s\n' "${preflight_errors[@]}" >&2
  if [ "${#missing_system_tools[@]}" -gt 0 ] && [ "$INSTALL_MISSING" -eq 0 ]; then
    printf '%s\n' 'verity-install: re-run with --install-missing to install tar/flock/OpenSSL automatically.' >&2
  fi
  exit 1
fi
printf '%s\n' 'verity-install: preflight passed'
[ "$PREFLIGHT_ONLY" -eq 0 ] || exit 0

run_docker() {
  as_root docker "$@"
}

managed_names=()
if ! managed_output=$(run_docker ps -a --filter 'name=^/verity-managed-server' --format '{{.Names}}'); then
  die 'could not inspect existing managed Server containers'
fi
while IFS= read -r name; do
  if [[ "$name" == verity-managed-server ]]; then
    managed_names+=("$name")
  elif [[ "$name" =~ ^verity-managed-server-g([1-9][0-9]*)$ ]]; then
    generation=${BASH_REMATCH[1]}
    if [ "${#generation}" -le 10 ] && [ "$generation" -le 2147483647 ]; then
      managed_names+=("$name")
    fi
  fi
done <<<"$managed_output"

if [ "${#managed_names[@]}" -gt 1 ]; then
  die 'more than one managed Server exists; wait for the in-flight update to finish'
fi
if [ "${#managed_names[@]}" -eq 1 ]; then
  source_image=$(run_docker inspect --format '{{.Config.Image}}' "${managed_names[0]}")
  printf 'verity-install: recovering release from %s\n' "${managed_names[0]}"
else
  source_image="$IMAGE_REPOSITORY:$IMAGE_TAG"
  printf 'verity-install: pulling %s\n' "$source_image"
fi
run_docker pull "$source_image" >/dev/null

image_digest=$(run_docker image inspect "$source_image" --format '{{range .RepoDigests}}{{println .}}{{end}}' |
  awk -v repository="$IMAGE_REPOSITORY" 'index($0, repository "@sha256:") == 1 { print; exit }')
digest_hex=${image_digest#"$IMAGE_REPOSITORY"@sha256:}
[ "$image_digest" = "$IMAGE_REPOSITORY@sha256:$digest_hex" ] ||
  die "Docker did not resolve $source_image to an official digest"
printf '%s\n' "$digest_hex" | grep -Eq '^[a-f0-9]{64}$' ||
  die "Docker did not resolve $source_image to an official digest"

container_id=''
privileged_root=''
cleanup() {
  if [ -n "$container_id" ]; then run_docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  if [ -n "$privileged_root" ]; then as_root rm -rf "$privileged_root" >/dev/null 2>&1 || true; fi
}
on_signal() {
  status=$1
  trap - EXIT
  cleanup
  exit "$status"
}
trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# Never execute a persistent path through sudo. A fresh root-owned directory
# prevents a previous run or another local account from replacing the guarded
# installer between validation and execution. Durable identity lives in
# /etc/verity and Docker volumes, not in this disposable release bundle.
[ "$(readlink -f /opt)" = /opt ] || die '/opt must not resolve through a symlink'
[ "$(stat -c '%u' /opt)" = 0 ] || die '/opt must be owned by root'
opt_mode=$(printf '%04d' "$(stat -c '%a' /opt)")
case "${opt_mode#??}" in
  *[2367]*) die '/opt must not be writable by group or other users' ;;
esac
privileged_root=$(as_root mktemp -d /opt/verity-install.XXXXXX)

container_id=$(run_docker create "$image_digest")
# Releases published before the Verity spelling correction embedded the same
# signed payload at /opt/varity-install. Probe without extracting so recovery
# can select the matching immutable image contract without mixing trees.
payload_root=/opt/verity-install
if ! run_docker cp "$container_id:$payload_root/." - >/dev/null 2>&1; then
  payload_root=/opt/varity-install
fi
# Keep pull/create/copy/remove on the same root-trusted Docker context while root
# extracts the image archive straight into root-owned staging. No user-writable
# tree crosses the privilege boundary.
run_docker cp "$container_id:$payload_root/." - |
  as_root tar -x -C "$privileged_root"
run_docker rm "$container_id" >/dev/null
container_id=''

as_root test -f "$privileged_root/deploy/bin/verity-install" || die 'release image has no installer payload'
as_root test ! -L "$privileged_root/deploy/bin/verity-install" || die 'release installer must not be a symlink'
as_root test -x "$privileged_root/deploy/bin/verity-install" || die 'release installer is not executable'
as_root test -f "$privileged_root/deploy/bin/verity-compose" || die 'release image has no Compose wrapper'
as_root test ! -L "$privileged_root/deploy/bin/verity-compose" || die 'release Compose wrapper must not be a symlink'

if [ "$(id -u)" -eq 0 ]; then
  "$privileged_root/deploy/bin/verity-install" --image "$image_digest" "${installer_args[@]}"
else
  sudo "$privileged_root/deploy/bin/verity-install" --image "$image_digest" "${installer_args[@]}"
fi
