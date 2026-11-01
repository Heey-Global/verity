"""Inject temporary buffered timing into the disposable helper copy only."""
from pathlib import Path

path = Path('/opt/verity-egress/project-egress-deadline.py')
source = path.read_text()
profile = '''
import atexit
_profile_events = []
def _profile(name, operation):
    def call(*args, **kwargs):
        start = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
        try:
            return operation(*args, **kwargs)
        finally:
            _profile_events.append({'phase': name, 'start': str(start),
                'end': str(time.clock_gettime_ns(time.CLOCK_BOOTTIME)),
                'args': list(args) if name == 'run' else []})
    return call
for _name in ('run', 'docker_read', 'endpoint', 'attest', 'save', 'renew_deadline', 'prepare_renewal'):
    globals()[_name] = _profile(_name, globals()[_name])
os.fsync = _profile('fsync', os.fsync)
def _flush_profile():
    with open('/evidence/helper-phases.jsonl', 'a') as output:
        print(json.dumps({'pid': os.getpid(), 'request': json.loads(data), 'phases': _profile_events}), file=output)
atexit.register(_flush_profile)
'''
source = source.replace("if __name__ == '__main__':", profile + "\nif __name__ == '__main__':")
path.write_text(source)
