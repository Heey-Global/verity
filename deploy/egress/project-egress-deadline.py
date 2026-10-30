"""Uninstalled root-only host helper for the experimental packet deadline guard.

No command, program path, namespace path or interface supplied by a Sandbox is
accepted. The trusted host adapter supplies its already registered binding.
"""
import ctypes
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import stat
import struct
import subprocess
import sys
import time

STATE = Path('/run/verity-egress-deadline')
PINS = Path('/sys/fs/bpf/verity_egress_deadline')
OBJECT = Path('/opt/verity-egress/project-egress-deadline.bpf.o')
BINDING_FIELDS = ('projectId', 'generation', 'containerId', 'networkId', 'endpointId', 'bridge', 'ipv4', 'ipv6')


def run(*args):
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=5,
                                       env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'DOCKER_HOST': 'unix:///var/run/docker.sock'})
    except subprocess.CalledProcessError as error:
        print(error.output[-8192:], file=sys.stderr)
        raise


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    value = path.lstat()
    if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or stat.S_IMODE(value.st_mode) != 0o700:
        raise ValueError('Untrusted deadline state directory')


def binding_key(binding):
    if set(binding) != set(BINDING_FIELDS):
        raise ValueError('Invalid deadline binding fields')
    for key in ('projectId', 'generation'):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', binding[key]):
            raise ValueError('Invalid deadline generation')
    for key in ('containerId', 'networkId', 'endpointId'):
        if not re.fullmatch(r'[a-f0-9]{64}', binding[key]):
            raise ValueError('Invalid deadline daemon identity')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,15}', binding['bridge']):
        raise ValueError('Invalid deadline bridge')
    if (ipaddress.ip_address(binding['ipv4']).version != 4
            or ipaddress.ip_address(binding['ipv6']).version != 6):
        raise ValueError('Invalid deadline endpoint address')
    encoded = json.dumps([binding[k] for k in BINDING_FIELDS], separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def clocks():
    before = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    real = time.time_ns()
    after = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    return {'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'realNs': str(real), 'bootBeforeNs': str(before), 'bootAfterNs': str(after)}


class ObjectAttr(ctypes.Structure):
    _fields_ = [('pathname', ctypes.c_uint64), ('fd', ctypes.c_uint32), ('flags', ctypes.c_uint32)]


class ElementAttr(ctypes.Structure):
    _fields_ = [('fd', ctypes.c_uint32), ('padding', ctypes.c_uint32),
                ('key', ctypes.c_uint64), ('value', ctypes.c_uint64), ('flags', ctypes.c_uint64)]


def bpf(command, attr):
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.syscall(321, command, ctypes.byref(attr), ctypes.sizeof(attr))
    if result < 0:
        raise OSError(ctypes.get_errno(), 'Deadline BPF syscall failed')
    return result


def write_deadline(root, index, deadline):
    pathname = ctypes.create_string_buffer(str(root / 'maps/deadline').encode())
    fd = bpf(7, ObjectAttr(ctypes.addressof(pathname), 0, 0))
    key = ctypes.c_uint32(0)
    value = ctypes.create_string_buffer(struct.pack('<QII', deadline, index, 0), 16)
    try:
        bpf(2, ElementAttr(fd, 0, ctypes.addressof(key), ctypes.addressof(value), 0))
    finally:
        os.close(fd)


def endpoint(binding):
    container = json.loads(run('/usr/bin/docker', 'container', 'inspect', binding['containerId']))[0]
    network = json.loads(run('/usr/bin/docker', 'network', 'inspect', binding['networkId']))[0]
    entries = list(container['NetworkSettings']['Networks'].values())
    if (container['Id'] != binding['containerId'] or network['Id'] != binding['networkId']
            or network['Driver'] != 'bridge' or not container['State']['Running'] or len(entries) != 1
            or network['Options'].get('com.docker.network.bridge.name') != binding['bridge']):
        raise ValueError('Deadline daemon identity mismatch')
    net = entries[0]
    for actual, expected in [('NetworkID', 'networkId'), ('EndpointID', 'endpointId'),
                             ('IPAddress', 'ipv4'), ('GlobalIPv6Address', 'ipv6')]:
        if net[actual] != binding[expected]:
            raise ValueError('Deadline attachment changed')
    namespace = container['NetworkSettings']['SandboxKey']
    if not re.fullmatch(r'/var/run/docker/netns/[a-zA-Z0-9_-]+', namespace):
        raise ValueError('Invalid deadline network namespace')
    links = json.loads(run('/usr/bin/nsenter', '--net=' + namespace, '/sbin/ip', '-j', 'link', 'show'))
    links = [link for link in links if link['ifname'] != 'lo']
    if len(links) != 1 or links[0]['address'] != net['MacAddress']:
        raise ValueError('Deadline namespace endpoint changed')
    candidates = [v for v in json.loads(run('/sbin/ip', '-j', '-d', 'link', 'show'))
                  if v['ifindex'] == links[0].get('link_index')]
    if len(candidates) != 1 or candidates[0].get('linkinfo', {}).get('info_kind') != 'veth':
        raise ValueError('Deadline requires an inspected software veth')
    peer = candidates[0]
    path = Path('/sys/class/net') / peer['ifname']
    if (int((path / 'iflink').read_text()) != links[0]['ifindex']
            or (path / 'master').resolve().name != binding['bridge']):
        raise ValueError('Deadline bridge peer changed')
    return {'device': peer['ifname'], 'index': peer['ifindex']}


def attest_filters(filters, identity):
    # tc may emit a separate protocol/chain header before the concrete filter.
    programs = []
    for entry in filters:
        if (entry.get('kind') != 'bpf' or entry.get('pref') != 1
                or entry.get('protocol') != 'all' or entry.get('chain', 0) != 0):
            raise ValueError('Unexpected deadline classifier')
        if 'options' in entry:
            programs.append(entry['options'])
        elif set(entry) - {'protocol', 'pref', 'kind', 'chain', 'parent'}:
            raise ValueError('Unexpected deadline classifier header')
    if len(programs) != 1:
        raise ValueError('Expected exactly one deadline program')
    options = programs[0]
    # Newer tc nests BPF program details; older dumps expose the id directly.
    program = options.get('prog', options)
    if (program.get('id') != identity or options.get('id', identity) != identity
            or programs[0].get('direct-action') is not True
            or programs[0].get('skip_hw') is not True or programs[0].get('skip_sw', False)
            or programs[0].get('in_hw', False) or programs[0].get('actions')):
        raise ValueError('Deadline hook identity changed: ' + json.dumps(filters))


def attest(root, peer, identity):
    ruleset = json.loads(run('/usr/sbin/nft', '-j', 'list', 'ruleset'))
    if any('flowtable' in entry for entry in ruleset['nftables']):
        raise ValueError('Flow offload is unsupported by packet deadline enforcement')
    program = json.loads(run('/usr/sbin/bpftool', '-j', 'prog', 'show', 'pinned', str(root / 'guard')))
    if isinstance(program, list):
        program = program[0]
    if program['id'] != identity or program['type'] != 'sched_cls':
        raise ValueError('Deadline program identity changed')
    for direction in ('ingress', 'egress'):
        filters = json.loads(run('/sbin/tc', '-j', 'filter', 'show', 'dev', peer['device'], direction))
        attest_filters(filters, identity)


def save(path, value):
    temporary = path.with_suffix('.pending')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def expiry_set_names(expiry):
    key = hashlib.sha256(('standing' if expiry is None else str(expiry)).encode()).hexdigest()[:16]
    return ('expired4_' + key, 'expired6_' + key)


def remember_expiry(binding, state):
    """Remember observed expiry; kernel sets also survive every admission update."""
    name = 'verity_egress_' + hashlib.sha256(
        (binding['projectId'] + ':' + binding['generation']).encode()).hexdigest()[:24]
    listing = json.loads(run('/usr/sbin/nft', '-j', 'list', 'table', 'inet', name))
    sets = {entry['set']['name']: entry['set'] for entry in listing['nftables'] if 'set' in entry}
    names = expiry_set_names(state.get('authorityExpiresAt'))
    if not set(names) <= sets.keys():
        raise ValueError('Missing authoritative expiry tombstones')
    if any(sets[key].get('elem') for key in names):
        expiry = state.get('authorityExpiresAt')
        if expiry is not None and expiry not in state['expiredAuthorities']:
            if len(state['expiredAuthorities']) >= 1000:
                raise ValueError('Deadline authority tombstone capacity exhausted')
            state['expiredAuthorities'].append(expiry)


def validate_lease(key, state, lease, pending=False):
    if (set(lease) != {'bootId', 'binding', 'revision', 'nonce', 'capturedBootNs', 'bootDeadlineNs', 'authorityExpiresAt', 'authorityBootDeadlineNs'}
            or lease['bootId'] != state['bootId'] or lease['binding'] != key
            or not isinstance(lease['revision'], int) or isinstance(lease['revision'], bool)
            or lease['revision'] < state['revision'] or not re.fullmatch(r'[a-f0-9]{32}', lease['nonce'])
            or lease['nonce'] == '0' * 32
            or not re.fullmatch(r'(?:0|[1-9][0-9]{0,19})', lease['bootDeadlineNs'])
            or not re.fullmatch(r'(?:0|[1-9][0-9]{0,19})', lease['capturedBootNs'])):
        raise ValueError('Invalid deadline lease')
    deadline = int(lease['bootDeadlineNs'])
    captured = int(lease['capturedBootNs'])
    expiry = lease['authorityExpiresAt']
    authority_boot = lease['authorityBootDeadlineNs']
    if (deadline > (1 << 64) - 1 or (expiry is not None and
            (not isinstance(expiry, int) or isinstance(expiry, bool)
             or expiry < 0 or expiry * 1_000_000 > (1 << 64) - 1))):
        raise ValueError('Deadline exceeds kernel range')
    if expiry is None:
        if authority_boot is not None:
            raise ValueError('Standing authority cannot acquire a temporary clock mapping')
    elif (not isinstance(authority_boot, str) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,19})', authority_boot)
          or int(authority_boot) > (1 << 64) - 1 or deadline > int(authority_boot)):
        raise ValueError('Invalid immutable authority clock mapping')
    original = state['authorityBootDeadlines'].get(str(expiry))
    if original is not None and (deadline > int(original) or captured >= int(original)):
        raise ValueError('Original authority clock budget exhausted')
    if expiry in state['expiredAuthorities']:
        raise ValueError('Authority already observed expired')
    if expiry not in state['seenAuthorities'] and len(state['seenAuthorities']) >= 1000:
        raise ValueError('Deadline authority capacity requires a fresh generation')
    sample = clocks()
    if ((captured <= int(state['invalidBeforeNs']) and not (pending and lease == state.get('pendingAdmission')))
            or captured <= int(state['lastCapturedNs'])
            or captured > int(sample['bootBeforeNs']) or captured > (1 << 64) - 1
            or (deadline != 0 and (deadline < captured or deadline - captured > 1_000_000_000))):
        raise ValueError('Deadline exceeds controller lifetime')
    return deadline, captured, expiry


def remember_authority(state, lease):
    expiry = lease['authorityExpiresAt']
    if expiry not in state['seenAuthorities']:
        state['seenAuthorities'].append(expiry)
    if expiry is not None:
        key = str(expiry)
        budget = int(lease['authorityBootDeadlineNs'])
        state['authorityBootDeadlines'][key] = str(min(budget, int(state['authorityBootDeadlines'].get(key, budget))))


def execute(request):
    if request == {'operation': 'clock'}:
        return clocks()
    if set(request) not in ({'operation', 'binding'}, {'operation', 'binding', 'lease'}):
        raise ValueError('Invalid deadline request')
    binding = request['binding']
    key = binding_key(binding)
    path = STATE / (key + '.json')
    root = PINS / key
    op = request['operation']
    if op not in ('prepare', 'arm', 'revoke'):
        raise ValueError('Unsupported deadline operation')
    if op == 'prepare' and not path.exists():
        peer = endpoint(binding)
        value = OBJECT.lstat()
        if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
            raise ValueError('Untrusted deadline object')
        private_directory(PINS)
        private_directory(root)
        private_directory(root / 'maps')
        run('/usr/sbin/bpftool', 'prog', 'load', str(OBJECT), str(root / 'guard'),
            'type', 'classifier', 'pinmaps', str(root / 'maps'))
        write_deadline(root, peer['index'], 0)
        # A dedicated veth with unknown classifiers is unsupported, not overwritten.
        qdisc = json.loads(run('/sbin/tc', '-j', 'qdisc', 'show', 'dev', peer['device']))
        if any(q.get('kind') == 'clsact' for q in qdisc):
            raise ValueError('Unexpected existing deadline qdisc')
        run('/sbin/tc', 'qdisc', 'add', 'dev', peer['device'], 'clsact')
        for direction in ('ingress', 'egress'):
            run('/sbin/tc', 'filter', 'add', 'dev', peer['device'], direction, 'pref', '1',
                'handle', '1', 'bpf', 'da', 'pinned', str(root / 'guard'), 'skip_hw')
        program = json.loads(run('/usr/sbin/bpftool', '-j', 'prog', 'show', 'pinned', str(root / 'guard')))
        if isinstance(program, list):
            program = program[0]
        state = {'binding': binding, 'peer': peer, 'bootId': clocks()['bootId'],
                 'program': program['id'], 'revision': -1,
                 'invalidBeforeNs': clocks()['bootAfterNs'], 'lastCapturedNs': '0',
                 'authorityExpiresAt': None, 'expiredAuthorities': [], 'uncertainExpiry': False,
                 'pendingAdmission': None, 'seenAuthorities': [None], 'authorityBootDeadlines': {}}
        attest(root, peer, state['program'])
        save(path, state)
        return {'state': 'denied'}
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or stat.S_IMODE(value.st_mode) != 0o600:
        raise ValueError('Untrusted deadline registration')
    state = json.loads(path.read_text())
    if state['binding'] != binding or state['bootId'] != clocks()['bootId']:
        raise ValueError('Deadline registration is stale')
    if state.get('uncertainExpiry', True):
        write_deadline(root, state['peer']['index'], 0)
        raise ValueError('Uncertain expiry requires a fresh generation')
    if op in ('revoke', 'prepare'):
        state['uncertainExpiry'] = True
        save(path, state)
        write_deadline(root, state['peer']['index'], 0)
        remember_expiry(binding, state)
        candidate = request.get('lease') if op == 'revoke' else None
        if candidate is not None:
            validate_lease(key, state, candidate)
            remember_authority(state, candidate)
        state['pendingAdmission'] = candidate
        state['invalidBeforeNs'] = clocks()['bootAfterNs']
        state['uncertainExpiry'] = False
        save(path, state)
        return {'state': 'denied'}
    # Validation and failed admission must not preserve the previous live grant.
    write_deadline(root, state['peer']['index'], 0)
    lease = request['lease']
    deadline, captured, expiry = validate_lease(key, state, lease, pending=True)
    if endpoint(binding) != state['peer']:
        raise ValueError('Deadline interface changed')
    attest(root, state['peer'], state['program'])
    state['pendingAdmission'] = None
    state['revision'] = lease['revision']
    state['lastCapturedNs'] = str(captured)
    state['authorityExpiresAt'] = expiry
    remember_authority(state, lease)
    save(path, state)
    # No remaining duration is recomputed here. An arbitrarily late update stays expired.
    write_deadline(root, state['peer']['index'], deadline)
    return {'state': 'armed', 'bootDeadlineNs': str(deadline)}


if __name__ == '__main__':
    if os.geteuid() != 0 or platform.machine() != 'x86_64':
        raise RuntimeError('Deadline helper requires the supported rootful x86_64 host')
    private_directory(STATE)
    lock = os.open(STATE / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    value = os.fstat(lock)
    if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or stat.S_IMODE(value.st_mode) != 0o600:
        os.close(lock)
        raise ValueError('Untrusted deadline lock')
    with os.fdopen(lock, 'w') as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        data = sys.stdin.buffer.read(16385)
        if len(data) > 16384:
            raise ValueError('Oversized deadline request')
        print(json.dumps(execute(json.loads(data))))
