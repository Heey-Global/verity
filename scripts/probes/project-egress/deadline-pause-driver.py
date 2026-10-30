"""Resume an actual stopped disposable controller/executor after its lease."""
import json
import os
from pathlib import Path
import signal
import sys
import time

assert os.geteuid() == 0 and os.environ.get('PROJECT_EGRESS_DISPOSABLE') == 'yes'
kind = sys.argv[1]
assert kind in ('controller', 'executor')
root = Path('/evidence')
request = root / ('deadline-pause-' + kind + '-request.json')
timeout = time.monotonic() + 30
while not request.exists() and time.monotonic() < timeout:
    time.sleep(0.01)
assert request.exists(), 'No actual pause request'
value = json.loads(request.read_text())
pid = value['pid']
assert isinstance(pid, int) and pid > 1
status = Path('/proc') / str(pid) / 'status'
while '\nState:\tT' not in status.read_text() and time.monotonic() < timeout:
    time.sleep(0.01)
assert '\nState:\tT' in status.read_text(), 'Process was not actually stopped'
stopped_status = status.read_text()
stopped = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
deadline = int(value['lease']['bootDeadlineNs'])
try:
    assert int(value['lease']['capturedBootNs']) <= stopped < deadline, 'Lease was not live at actual stop'
    resume_after = max(stopped + 2_000_000_000, deadline + 200_000_000)
    while time.clock_gettime_ns(time.CLOCK_BOOTTIME) < resume_after:
        time.sleep(0.02)
finally:
    os.kill(pid, signal.SIGCONT)
resumed = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
(root / ('deadline-pause-' + kind + '-result.json')).write_text(json.dumps({
    'kind': kind, 'pid': pid, 'lease': value['lease'], 'stopped_ns': str(stopped),
    'resumed_ns': str(resumed), 'complete': True,
    'status_at_stop': stopped_status,
}))
