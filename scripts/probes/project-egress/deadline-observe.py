"""Read raw maps from the actual disposable host adapter; never runs in projects."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys

assert os.geteuid() == 0 and os.environ.get('PROJECT_EGRESS_DISPOSABLE') == 'yes'
spec = importlib.util.spec_from_file_location('deadline', '/opt/verity-egress/project-egress-deadline.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
binding = json.loads(sys.argv[1])
identity = host.binding_key(binding)
state = json.loads((host.STATE / (identity + '.json')).read_text())
assert state['binding'] == binding
containers = None
if sys.argv[2:] == ['--containment']:
    ids = [binding['containerId'], state['relayRegistration']['containerId']]
    containers = [json.loads(host.docker_inspect('container', value))[0] for value in ids]
    assert [row['Id'] for row in containers] == ids
    assert host.kernel_program(host.PINS / identity)['id'] == state['program']
    if all(row['State']['Running'] for row in containers):
        assert host.endpoint(binding) == state['peer']
        host.attest(host.PINS / identity, state['peer'], state['program'])
else:
    assert not sys.argv[2:]
    assert host.endpoint(binding) == state['peer']
    host.attest(host.PINS / identity, state['peer'], state['program'])


def read(name, size):
    path = ctypes.create_string_buffer(str(host.PINS / identity / 'maps' / name).encode())
    fd = host.bpf(7, host.ObjectAttr(ctypes.addressof(path), 0, 0))
    key = ctypes.c_uint32(0)
    value = ctypes.create_string_buffer(size)
    try:
        host.bpf(1, host.ElementAttr(fd, 0, ctypes.addressof(key), ctypes.addressof(value), 0))
        return value.raw
    finally:
        os.close(fd)


possible = Path('/sys/devices/system/cpu/possible').read_text().strip()
cpus = sum(int(v.split('-')[-1]) - int(v.split('-')[0]) + 1 for v in possible.split(','))
rows = [struct.unpack_from('<QQQQ', data, i * 32)
        for data in [read('observations', cpus * 32)] for i in range(cpus)]
deadline, index, reserved = struct.unpack('<QII', read('deadline', 16))
assert reserved == 0 and index == state['peer']['index']
print(json.dumps({'identity': identity, 'state': state, 'clocks': host.clocks(),
                  'containers': containers, 'deadline_ns': str(deadline), 'accepted': sum(v[0] for v in rows),
                  'denied': sum(v[1] for v in rows),
                  'last_accepted_boot_ns': str(max(v[2] for v in rows)),
                  'last_denied_boot_ns': str(max(v[3] for v in rows))}))
