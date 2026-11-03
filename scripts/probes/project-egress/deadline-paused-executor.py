"""Trace the unchanged host helper and SIGSTOP immediately before its map commit."""
import json
import os
from pathlib import Path
import runpy
import signal
import sys

assert os.geteuid() == 0 and os.environ.get('PROJECT_EGRESS_DISPOSABLE') == 'yes'
helper = '/opt/verity-egress/project-egress-deadline.py'
stopped = False


def trace(frame, event, arg):
    global stopped
    if (not stopped and event == 'call' and frame.f_code.co_filename == helper
            and frame.f_code.co_name == 'write_deadline' and frame.f_locals['deadline'] > 0):
        stopped = True
        lease = frame.f_back.f_locals['lease']
        request = Path('/evidence/deadline-pause-executor-request.json')
        temporary = request.with_suffix('.pending')
        temporary.write_text(json.dumps({'pid': os.getpid(), 'lease': lease}))
        temporary.replace(request)
        os.kill(os.getpid(), signal.SIGSTOP)
    return trace


sys.settrace(trace)
runpy.run_path(helper, run_name='__main__')
assert stopped, 'Actual helper never reached the immutable map commit'
