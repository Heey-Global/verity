#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Native late-attachment checks require macOS and Xcode.' >&2
  exit 2
fi
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sources=(
  apps/mobile/native/RemoteDataDiagnostics.swift
  apps/mobile/native/RemoteSmokeTunnel.swift
  apps/mobile/native/CertificatePinDelegate.swift
  apps/mobile/native/PinnedHTTPSessionPool.swift
  scripts/remote-control-tunnel/LateAttachment.swift
)
# Bound subprocesses without depending on GNU timeout on the Apple runner.
run_bounded() {
  python3 - "$@" <<'PY'
import subprocess
import sys
try:
    result = subprocess.run(sys.argv[1:], timeout=120, check=False)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
raise SystemExit(result.returncode)
PY
}
compile() {
  run_bounded xcrun swiftc -D VERITY_ATTACHMENT_LIFECYCLE_TEST -parse-as-library \
    -target "$(uname -m)-apple-macos14.0" \
    "${sources[@]}" "$1" -o "$2"
}
compile apps/mobile/native/RemoteAppTunnel.swift "$tmp/check"
run_bounded "$tmp/check"
python3 - apps/mobile/native/RemoteAppTunnel.swift "$tmp/RemoteAppTunnel.swift" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text()
guard = '        guard !stopped else { return false }\n'
if source.count(guard) != 1:
    raise SystemExit('Expected exactly one listener stop guard')
Path(sys.argv[2]).write_text(source.replace(guard, '', 1))
PY
# A compiler error cannot establish that the behavioral guard detects the mutation.
compile "$tmp/RemoteAppTunnel.swift" "$tmp/mutated-check"
set +e
run_bounded "$tmp/mutated-check" > "$tmp/mutated-result" 2> "$tmp/mutated-stderr"
status=$?
set -e
if [[ "$status" != 1 ]] || [[ "$(cat "$tmp/mutated-result")" != native-late-attachment-rejected ]]; then
  echo 'Native late-attachment mutation did not produce the expected assertion failure.' >&2
  exit 1
fi
echo 'Native late-attachment checks pass; revival mutation rejected.'
