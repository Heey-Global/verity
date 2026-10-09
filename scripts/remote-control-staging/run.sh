#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Remote Control staging probe requires macOS 14 or newer.' >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
xcrun swiftc -parse-as-library -target "$(uname -m)-apple-macosx14.0" \
  apps/mobile/native/CertificatePinDelegate.swift \
  apps/mobile/native/RemoteSmokeTunnel.swift \
  apps/mobile/native/RemoteDataDiagnostics.swift apps/mobile/native/RemoteAppTunnel.swift \
  scripts/remote-control-staging/StagingProbe.swift \
  -o "$tmp/staging-probe"
VERITY_REMOTE_PROBE_BINARY="$tmp/staging-probe" \
  node scripts/remote-control-staging/probe.mjs
