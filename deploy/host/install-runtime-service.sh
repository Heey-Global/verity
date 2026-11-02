#!/usr/bin/env bash
# Shared by verity-install and the authenticated, runtime-only renewal helper.
set -euo pipefail
umask 077
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
state=${VERITY_HOST_RUNTIME_DIR:-/var/lib/verity/host-runtime}
private=${VERITY_HOST_RUNTIME_PRIVATE_DIR:-/var/lib/verity/host-runtime-private}
libexec=${VERITY_HOST_RUNTIME_LIBEXEC:-/usr/local/libexec/verity}
units=${VERITY_SYSTEMD_UNIT_DIR:-/etc/systemd/system}
run=${VERITY_SYSTEMD_RUN_DIR:-/run/systemd/system}
transaction="$private/service-install"
die() { echo "install-runtime-service: $*" >&2; exit 1; }
[[ $(id -u) = 0 || ${VERITY_HOST_RUNTIME_TEST:-} = 1 ]] || die 'requires root'
for directory in "$state" "$private" "$libexec" "$units"; do
  [[ ! -L $directory ]] || die "unsafe directory: $directory"
  if [[ ! -d $directory ]]; then
    mode=0755
    [[ $directory != "$state" && $directory != "$private" ]] || mode=0700
    install -d -m "$mode" "$directory"
  fi
  [[ $(readlink -f "$directory") = "$directory" ]] || die "noncanonical directory: $directory"
  [[ $(stat -c %u "$directory") = 0 || ${VERITY_HOST_RUNTIME_TEST:-} = 1 ]] || die 'directory must be root-owned'
  [[ $(( 8#$(stat -c %a "$directory") & 8#22 )) = 0 ]] || die 'directory is writable by other users'
done
chmod 0700 "$private"
[[ ! -L $private/lock ]] || die 'unsafe runtime lock'
exec 9>"$private/lock"
flock -w 60 9 || die 'another runtime operation is still running'
files=("$libexec/verity-host-runtime" "$units/verity-host-runtime.service" "$units/verity-host-runtime.path" "$state/agent.json")
for file in "${files[@]}"; do [[ ! -L $file ]] || die "unsafe destination: $file"; done
[[ ! -L $transaction ]] || die 'unsafe transaction directory'
systemd=false
[[ -d $run ]] && systemd=true
atomic_copy() {
  local temporary
  temporary=$(mktemp "$(dirname "$2")/.runtime-install.XXXXXXXX")
  cp -p -- "$1" "$temporary"
  sync -f "$temporary"
  mv -fT -- "$temporary" "$2"
  sync -f "$(dirname "$2")"
}
restore() {
  local index=0 failed=0
  if $systemd; then systemctl stop verity-host-runtime.path || failed=1; fi
  for file in "${files[@]}"; do
    if [[ -f $transaction/$index ]]; then
      atomic_copy "$transaction/$index" "$file" || failed=1
    elif [[ -f $transaction/$index.absent ]]; then
      rm -f -- "$file" || failed=1
    else
      failed=1
    fi
    index=$((index + 1))
  done
  index=0
  for file in "${files[@]}"; do
    if [[ -f $transaction/$index ]]; then
      [[ -f $file && $(sha512sum <"$file") = $(sha512sum <"$transaction/$index") && $(stat -c %a "$file") = $(stat -c %a "$transaction/$index") ]] || failed=1
    else
      [[ ! -e $file ]] || failed=1
    fi
    index=$((index + 1))
  done
  if $systemd; then
    systemctl daemon-reload || failed=1
    if [[ -f $transaction/enabled ]]; then
      systemctl enable verity-host-runtime.path || failed=1
    else
      systemctl disable verity-host-runtime.path || failed=1
    fi
    if [[ -f $transaction/active ]]; then
      systemctl start verity-host-runtime.path || failed=1
      systemctl is-active --quiet verity-host-runtime.path || failed=1
    elif systemctl is-active --quiet verity-host-runtime.path; then
      failed=1
    fi
    if [[ -f $transaction/enabled ]]; then
      systemctl is-enabled --quiet verity-host-runtime.path || failed=1
    elif systemctl is-enabled --quiet verity-host-runtime.path; then
      failed=1
    fi
  fi
  (( failed == 0 )) || return 1
  rm -rf -- "$transaction"
  sync -f "$private"
  rm -f "$state/service-install.pending"
  sync -f "$state"
}
# A SIGKILL leaves the original backup intact. Recover it before taking a new backup.
if [[ -e $transaction/pending ]]; then
  restore || die 'recovery-required: could not restore the previous runtime service'
elif [[ -e $transaction ]]; then
  rm -rf -- "$transaction"
fi
bash -n "$source_dir/verity-host-runtime"
for unit in verity-host-runtime.service verity-host-runtime.path; do
  [[ -f $source_dir/$unit && ! -L $source_dir/$unit ]] || die 'missing runtime unit'
done
mkdir -m 0700 "$transaction"
index=0
for file in "${files[@]}"; do
  if [[ -e $file ]]; then cp -p -- "$file" "$transaction/$index"; else touch "$transaction/$index.absent"; fi
  index=$((index + 1))
done
if $systemd; then
  if systemctl is-active --quiet verity-host-runtime.path; then touch "$transaction/active"; fi
  if systemctl is-enabled --quiet verity-host-runtime.path; then touch "$transaction/enabled"; fi
fi
jq -cn --arg deployment "${VERITY_RENEW_DEPLOYMENT:-}" --arg id "${VERITY_RENEW_ID:-}" --arg image "${VERITY_RENEW_IMAGE:-}" \
  '{version:1,deploymentId:$deployment,updateId:$id,targetDigest:$image}' >"$transaction/intent.json"
sync -f "$transaction"
touch "$state/service-install.pending"
sync -f "$state"
touch "$transaction/pending"
sync -f "$transaction"
rollback_on_exit() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    if restore; then
      echo 'install-runtime-service: renewal failed; previous service restored' >&2
      outcome=restored
    else
      echo 'install-runtime-service: recovery-required: previous service restoration could not be verified' >&2
      outcome=recovery-required
    fi
    jq -cn --arg id "${VERITY_RENEW_ID:-}" --arg image "${VERITY_RENEW_IMAGE:-}" --arg outcome "$outcome" \
      '{version:1,updateId:$id,targetDigest:$image,outcome:$outcome}'
  fi
  exit "$status"
}
trap rollback_on_exit EXIT
if $systemd; then
  systemctl stop verity-host-runtime.path
  # Do not interrupt a request already executing, including an older service implementation.
  if systemctl is-active --quiet verity-host-runtime.service; then die 'runtime request is still executing; retry later'; fi
fi
install -m 0755 "$source_dir/verity-host-runtime" "$transaction/new-script"
atomic_copy "$transaction/new-script" "${files[0]}"
for unit in verity-host-runtime.service verity-host-runtime.path; do
  install -m 0644 "$source_dir/$unit" "$transaction/new-unit"
  atomic_copy "$transaction/new-unit" "$units/$unit"
done
trigger=none
if $systemd; then
  systemctl daemon-reload
  for unit in verity-host-runtime.service verity-host-runtime.path; do
    [[ $(systemctl show --property=LoadState --value "$unit") = loaded ]] || die "invalid runtime unit: $unit"
  done
  systemctl enable --now verity-host-runtime.path
  systemctl is-active --quiet verity-host-runtime.path
  trigger=systemd-path
fi
agent='{}'
[[ ! -f $state/agent.json ]] || agent=$(jq -ce 'select(type == "object")' "$state/agent.json")
hash=$(sha512sum <"${files[0]}" | cut -d' ' -f1)
jq -cn --argjson previous "$agent" --arg trigger "$trigger" --arg builder "${VERITY_HOST_BUILDER_TRIGGER:-}" --arg hash "$hash" \
  --argjson receipt "$(cat "$transaction/intent.json")" \
  '$previous + (if $builder == "" then {} else {builder:$builder} end) + {version:1,trigger:$trigger,runtimeArtifacts:["binary","archive"],runtimeService:{revision:1,renewalProtocol:1,features:["binary","archive"],sha512:$hash,receipt:$receipt}}' >"$transaction/agent"
chmod 0644 "$transaction/agent"
atomic_copy "$transaction/agent" "$state/agent.json"
# Removing pending is the commit point; cleanup after a crash never restores a committed install.
rm "$transaction/pending"
sync -f "$transaction"
trap - EXIT
rm -rf -- "$transaction"
sync -f "$private"
rm -f "$state/service-install.pending"
sync -f "$state"
