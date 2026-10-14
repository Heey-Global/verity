#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Writer reproduction requires macOS and Xcode.' >&2
  exit 2
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
python3 - apps/mobile/native/RemoteAppTunnel.swift "$tmp" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text()
start = source.index('  private actor Writer {')
end = source.index('\n  private final class Stream', start)
writer = source[start:end].replace('private actor Writer', 'actor Writer', 1)
# A test-only queue counter proves the sibling reached the actual send method.
needle = '      let predecessor = previous\n'
assert writer.count(needle) == 1
writer = writer.replace('actor Writer {', 'actor Writer {\n    var queuedForTest = 0', 1)
writer = writer.replace(needle, '      queuedForTest += 1\n' + needle, 1)
prefix = 'import Foundation\nenum RemoteSmokeError: Error { case limitReached, sendStalled }\n'
Path(sys.argv[2], 'Writer.swift').write_text(prefix + writer)
mutation = '        if let predecessor { try await predecessor.value }\n'
assert writer.count(mutation) == 1
Path(sys.argv[2], 'MutatedWriter.swift').write_text(prefix + writer.replace(mutation, '', 1))
needle = '        diagnostics?.started(token)'
assert writer.count(needle) == 1
Path(sys.argv[2], 'UnobservedWriter.swift').write_text(prefix + writer.replace(needle, '', 1))
# A deadline whose sleeper never resumes the continuation leaves a stuck send
# stuck; the deadline check must see that, not the host watchdog.
needle = '          if !Task.isCancelled { once.resume(RemoteSmokeError.sendStalled) }'
assert writer.count(needle) == 1
Path(sys.argv[2], 'DeadlessWriter.swift').write_text(prefix + writer.replace(needle, '          if Task.isCancelled { once.resume(RemoteSmokeError.sendStalled) }', 1))
PY
run_bounded() {
  python3 - "$@" <<'PY'
import subprocess, sys
try:
    result = subprocess.run(sys.argv[1:], timeout=120, check=False)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
raise SystemExit(result.returncode)
PY
}
for variant in Writer MutatedWriter UnobservedWriter; do
  run_bounded xcrun swiftc -parse-as-library -D VERITY_STALL_DIAGNOSTICS -target "$(uname -m)-apple-macosx14.0" \
    "$tmp/$variant.swift" scripts/remote-control-staging/StallWriterDiagnostics.swift scripts/remote-control-tunnel/WriterStall.swift -o "$tmp/$variant"
done
run_bounded "$tmp/Writer"
# Compilation failure or a watchdog timeout is not evidence of mutation detection.
set +e
run_bounded "$tmp/MutatedWriter" > "$tmp/mutation.log" 2>&1
status=$?
set -e
[[ "$status" == 1 ]] && grep -q '^writer-stall-not-reproduced$' "$tmp/mutation.log"

set +e
run_bounded "$tmp/UnobservedWriter" > "$tmp/unobserved.log" 2>&1
status=$?
set -e
[[ "$status" == 1 ]] && grep -q '^writer-diagnostics-not-reproduced$' "$tmp/unobserved.log"

# The send deadline against a socket whose send never completes: the actual
# Writer must give up with a stall and raise its hook; a Writer whose sleeper
# cannot resume the wait must be caught by the check's own bound.
for variant in Writer DeadlessWriter; do
  run_bounded xcrun swiftc -parse-as-library -D VERITY_STALL_DIAGNOSTICS -target "$(uname -m)-apple-macosx14.0" \
    "$tmp/$variant.swift" scripts/remote-control-staging/StallWriterDiagnostics.swift scripts/remote-control-tunnel/WriterDeadline.swift -o "$tmp/$variant-deadline"
done
run_bounded "$tmp/Writer-deadline"
set +e
run_bounded "$tmp/DeadlessWriter-deadline" > "$tmp/deadless.log" 2>&1
status=$?
set -e
[[ "$status" == 1 ]] && grep -q '^writer-deadline-not-enforced$' "$tmp/deadless.log"
