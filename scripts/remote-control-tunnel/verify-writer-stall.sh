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
prefix = 'import Foundation\nenum RemoteSmokeError: Error { case limitReached, sendStalled }\n'
Path(sys.argv[2], 'Writer.swift').write_text(prefix + writer)
reset_start = source.index('  private func reset(_ id: String, code: String) async {')
reset_end = source.index('\n  private func accept(', reset_start)
reset = source[reset_start:reset_end].replace('private func ', 'func ')
reset_prefix = """import Foundation
final class ResetTunnel: @unchecked Sendable {
  final class Stream { var opened = false; var pendingReset: String? }
  let lock = NSLock()
  let writer = ResetWriter()
  var streams: [String: Stream] = [:]
  func insert(_ id: String) -> Stream {
    lock.withLock { let stream = Stream(); streams[id] = stream; return stream }
  }
  func drop(_ id: String, reason: String) -> Bool {
    lock.withLock { streams.removeValue(forKey: id) != nil }
  }
"""
Path(sys.argv[2], 'ResetTunnel.swift').write_text(reset_prefix + reset + '\n}\n')
needle_reset = 'stream.pendingReset = code'
assert reset.count(needle_reset) == 1
Path(sys.argv[2], 'LostResetTunnel.swift').write_text(
    reset_prefix + reset.replace(needle_reset, 'stream.pendingReset = nil', 1) + '\n}\n')

# A send must not be observed as started before it reaches the socket.
needle = '          diagnostics?.started(token)'
assert writer.count(needle) == 1
Path(sys.argv[2], 'UnobservedWriter.swift').write_text(prefix + writer.replace(needle, '', 1))
# A chain across streams brought back: each send waits for the one before it.
needle = '      else { throw RemoteSmokeError.limitReached }\n'
assert writer.count(needle) == 1
chained = writer.replace('actor Writer {', 'actor Writer {\n    var sendingForTest = false', 1)
chained = chained.replace(needle, needle + '      while sendingForTest { await Task.yield() }\n      sendingForTest = true\n      defer { sendingForTest = false }\n', 1)
Path(sys.argv[2], 'ChainedWriter.swift').write_text(prefix + chained)
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
for variant in Writer UnobservedWriter ChainedWriter; do
  run_bounded xcrun swiftc -parse-as-library -D VERITY_STALL_DIAGNOSTICS -target "$(uname -m)-apple-macosx14.0" \
    "$tmp/$variant.swift" scripts/remote-control-staging/StallWriterDiagnostics.swift scripts/remote-control-tunnel/WriterStall.swift -o "$tmp/$variant"
done
run_bounded "$tmp/Writer"
# Compilation failure or a watchdog timeout is not evidence of mutation detection.
set +e
run_bounded "$tmp/UnobservedWriter" > "$tmp/unobserved.log" 2>&1
status=$?
set -e
[[ "$status" == 1 ]] && grep -q '^writer-diagnostics-not-reproduced$' "$tmp/unobserved.log"
set +e
run_bounded "$tmp/ChainedWriter" > "$tmp/chained.log" 2>&1
status=$?
set -e
[[ "$status" == 1 ]] && grep -q '^writer-chain-reintroduced$' "$tmp/chained.log"

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

# An open accepted by the peer can complete locally after stream retirement.
for variant in ResetTunnel LostResetTunnel; do
  run_bounded xcrun swiftc -parse-as-library -target "$(uname -m)-apple-macosx14.0" \
    "$tmp/$variant.swift" scripts/remote-control-tunnel/OpenReset.swift -o "$tmp/$variant"
done
run_bounded "$tmp/ResetTunnel"
set +e
run_bounded "$tmp/LostResetTunnel" > "$tmp/lost-reset.log" 2>&1
status=$?
set -e
[[ "$status" == 1 ]] && grep -q '^deferred-reset-missing$' "$tmp/lost-reset.log"
