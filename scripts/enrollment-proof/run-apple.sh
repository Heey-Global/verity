#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Requires macOS, Xcode command-line tools.' >&2
  exit 2
fi
tmp="$(mktemp -d)"
service="verity.enrollment.probe.$(uuidgen)"
cleanup() {
  if [[ -x "$tmp/probe" ]]; then "$tmp/probe" delete "$service" || true; fi
  security delete-keychain "$tmp/probe.keychain-db" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
# Disposable Keychain avoids CI prompts and never changes the login search list.
export VERITY_PROBE_KEYCHAIN="$tmp/probe.keychain-db"
probe_password="$(uuidgen)"
security create-keychain -p "$probe_password" "$VERITY_PROBE_KEYCHAIN"
security unlock-keychain -p "$probe_password" "$VERITY_PROBE_KEYCHAIN"
unset probe_password
xcrun swiftc scripts/enrollment-proof/AppleProof.swift -o "$tmp/probe"
"$tmp/probe" create "$service" "$tmp/public"
"$tmp/probe" verify "$service" "$tmp/public" scripts/enrollment-proof/vector.json
