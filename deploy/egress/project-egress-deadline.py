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

STATE = Path('/var/lib/verity-egress/deadline')
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


class TestRunAttr(ctypes.Structure):
    _fields_ = [('prog_fd', ctypes.c_uint32), ('retval', ctypes.c_uint32),
                ('data_size_in', ctypes.c_uint32), ('data_size_out', ctypes.c_uint32),
                ('data_in', ctypes.c_uint64), ('data_out', ctypes.c_uint64),
                ('repeat', ctypes.c_uint32), ('duration', ctypes.c_uint32),
                ('ctx_size_in', ctypes.c_uint32), ('ctx_size_out', ctypes.c_uint32),
                ('ctx_in', ctypes.c_uint64), ('ctx_out', ctypes.c_uint64),
                ('flags', ctypes.c_uint32), ('cpu', ctypes.c_uint32), ('batch_size', ctypes.c_uint32)]


def renew_deadline(root, index, previous, deadline):
    program = root / 'renew'
    if not program.exists():
        obj = OBJECT.with_name('project-egress-renew.bpf.o')
        value = obj.lstat()
        if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
            raise ValueError('Untrusted deadline renewal object')
        run('/usr/sbin/bpftool', 'prog', 'load', str(obj), str(program),
            'map', 'name', 'deadline', 'pinned', str(root / 'maps/deadline'))
    pathname = ctypes.create_string_buffer(str(program).encode())
    fd = bpf(7, ObjectAttr(ctypes.addressof(pathname), 0, 0))
    packet = bytearray(78)
    packet[12:14] = bytes.fromhex('0800')
    packet[14] = 0x45
    packet[16:18] = (64).to_bytes(2, 'big')
    packet[22:24] = bytes([64, 6])
    packet[46] = 0x50
    packet[54:] = struct.pack('<QQII', previous, deadline, index, 0)
    data = ctypes.create_string_buffer(bytes(packet), len(packet))
    output = ctypes.create_string_buffer(len(packet))
    attr = TestRunAttr(prog_fd=fd, data_size_in=len(packet), data_size_out=len(packet),
                       data_in=ctypes.addressof(data), data_out=ctypes.addressof(output), repeat=1)
    try:
        bpf(10, attr)
        if attr.retval != 1:
            raise ValueError('Kernel deadline continuity expired or changed')
    finally:
        os.close(fd)


def write_relay(root, policy=None):
    pathname = ctypes.create_string_buffer(str(root / 'maps/relay_transport').encode())
    fd = bpf(7, ObjectAttr(ctypes.addressof(pathname), 0, 0))
    key = ctypes.c_uint32(0)
    value = ctypes.create_string_buffer(policy if policy is not None else bytes(28), 28)
    try:
        bpf(2, ElementAttr(fd, 0, ctypes.addressof(key), ctypes.addressof(value), 0))
    finally:
        os.close(fd)


def relay_policy(binding, peer, registration):
    if (not isinstance(registration, dict)
            or set(registration) != {'containerId', 'endpointId', 'codex'}
            or type(registration['codex']) is not bool
            or any(not isinstance(registration[k], str) or not re.fullmatch(r'[a-f0-9]{64}', registration[k])
                   for k in ('containerId', 'endpointId'))
            or registration['containerId'] == binding['containerId']):
        raise ValueError('Invalid registered relay identity')
    network = json.loads(run('/usr/bin/docker', 'network', 'inspect', binding['networkId']))[0]
    if set(network['Containers']) != {binding['containerId'], registration['containerId']}:
        raise ValueError('Relay requires exactly the registered project pair')
    sandbox = json.loads(run('/usr/bin/docker', 'container', 'inspect', binding['containerId']))[0]
    relay = json.loads(run('/usr/bin/docker', 'container', 'inspect', registration['containerId']))[0]
    sandbox_net = list(sandbox['NetworkSettings']['Networks'].values())[0]
    relay_nets = list(relay['NetworkSettings']['Networks'].values())
    if len(relay_nets) != 1:
        raise ValueError('Relay requires one dedicated attachment')
    relay_net = relay_nets[0]
    relay_binding = {**binding, 'containerId': registration['containerId'],
                     'endpointId': registration['endpointId'], 'ipv4': relay_net['IPAddress'],
                     'ipv6': relay_net['GlobalIPv6Address']}
    binding_key(relay_binding)
    # Inspect both namespaces and their software veth/bridge membership.
    if endpoint(binding) != peer:
        raise ValueError('Relay sandbox interface changed')
    relay_peer = endpoint(relay_binding)
    if relay_peer['index'] == peer['index']:
        raise ValueError('Relay shares the sandbox interface')
    addresses = [ipaddress.IPv4Address(b['ipv4']) for b in (binding, relay_binding)]
    macs = []
    for net, identity, address in ((sandbox_net, binding['containerId'], addresses[0]),
                                   (relay_net, registration['containerId'], addresses[1])):
        mac = net['MacAddress']
        topology = network['Containers'][identity]
        if (not isinstance(mac, str) or not re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', mac)
                or topology['MacAddress'] != mac
                or ipaddress.IPv4Interface(topology['IPv4Address']).ip != address):
            raise ValueError('Relay daemon endpoint disagreement')
        raw = bytes.fromhex(mac.replace(':', ''))
        if raw == bytes(6) or raw[0] & 1:
            raise ValueError('Invalid relay hardware address')
        macs.append(raw)
    if addresses[0] == addresses[1] or macs[0] == macs[1]:
        raise ValueError('Ambiguous relay endpoints')
    if any(a.is_unspecified or a.is_multicast or a.is_loopback or a.is_link_local for a in addresses):
        raise ValueError('Invalid relay address')
    return struct.pack('<II', 1, int(registration['codex'])) + b''.join(a.packed for a in addresses) + b''.join(macs)


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
    for expiry in state['nftAuthorities']:
        names = expiry_set_names(expiry)
        if not set(names) <= sets.keys():
            raise ValueError('Missing authoritative expiry tombstones')
        if any(sets[key].get('elem') for key in names):
            if expiry is not None and expiry not in state['expiredAuthorities']:
                if len(state['expiredAuthorities']) >= 1000:
                    raise ValueError('Deadline authority tombstone capacity exhausted')
                state['expiredAuthorities'].append(expiry)


def validate_lease(key, state, lease, pending=False):
    if (set(lease) != {'bootId', 'binding', 'revision', 'nonce', 'capturedBootNs', 'bootDeadlineNs', 'authorityExpiresAt', 'authorityBootDeadlines'}
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
    budgets = lease['authorityBootDeadlines']
    if (deadline > (1 << 64) - 1 or (expiry is not None and
            (not isinstance(expiry, int) or isinstance(expiry, bool)
             or expiry < 0 or expiry * 1_000_000 > (1 << 64) - 1))):
        raise ValueError('Deadline exceeds kernel range')
    if not isinstance(budgets, dict) or len(budgets) > 1000:
        raise ValueError('Invalid immutable authority clock mappings')
    if (expiry is None and budgets) or (expiry is not None and str(expiry) not in budgets):
        raise ValueError('Missing immutable authority clock mapping')
    for key_expiry, budget in budgets.items():
        if (not re.fullmatch(r'(?:0|[1-9][0-9]{0,13})', key_expiry)
                or int(key_expiry) * 1_000_000 > (1 << 64) - 1
                or not isinstance(budget, str) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,19})', budget)
                or int(budget) > (1 << 64) - 1 or deadline > int(budget)
                or int(key_expiry) < expiry):
            raise ValueError('Invalid immutable authority clock mapping')
        original = state['authorityBootDeadlines'].get(key_expiry)
        if original is not None and (deadline > int(original) or captured >= int(original)):
            raise ValueError('Original authority clock budget exhausted')
        if int(key_expiry) in state['expiredAuthorities']:
            raise ValueError('Authority already observed expired')
    seen = set(state['seenAuthorities']) | {int(key) for key in budgets}
    if len(seen) > 1000:
        raise ValueError('Deadline authority capacity requires a fresh generation')
    sample = clocks()
    staged = state.get('pendingAdmission')
    # DNS/tuple resolution may only shorten the originally staged lease. Every
    # identity and immutable authority budget must still match its own revoke.
    staged_match = (pending and isinstance(staged, dict)
                    and {**lease, 'bootDeadlineNs': staged['bootDeadlineNs']} == staged
                    and deadline <= int(staged['bootDeadlineNs']))
    if ((captured <= int(state['invalidBeforeNs']) and not staged_match)
            or captured <= int(state['lastCapturedNs'])
            or captured > int(sample['bootBeforeNs']) or captured > (1 << 64) - 1
            or (deadline != 0 and (deadline < captured or deadline - captured > 1_000_000_000))):
        raise ValueError('Deadline exceeds controller lifetime')
    return deadline, captured, expiry


def remember_authority(state, lease):
    for key, value in lease['authorityBootDeadlines'].items():
        expiry = int(key)
        if expiry not in state['seenAuthorities']:
            state['seenAuthorities'].append(expiry)
        budget = int(value)
        state['authorityBootDeadlines'][key] = str(min(budget, int(state['authorityBootDeadlines'].get(key, budget))))


def execute(request):
    if request == {'operation': 'clock'}:
        return clocks()
    if set(request) not in ({'operation', 'binding'}, {'operation', 'binding', 'lease'},
                            {'operation', 'binding', 'relay'},
                            {'operation', 'binding', 'lease', 'previousBootDeadlineNs'}):
        raise ValueError('Invalid deadline request')
    binding = request['binding']
    key = binding_key(binding)
    path = STATE / (key + '.json')
    root = PINS / key
    op = request['operation']
    fields = {
        'prepare': ({'operation', 'binding'},),
        'arm': ({'operation', 'binding', 'lease'},),
        'renew': ({'operation', 'binding', 'lease', 'previousBootDeadlineNs'},),
        'revoke': ({'operation', 'binding'}, {'operation', 'binding', 'lease'}),
        'configure-relay': ({'operation', 'binding', 'relay'},),
        'clear-relay': ({'operation', 'binding'},),
    }
    if op not in fields or set(request) not in fields[op]:
        raise ValueError('Unsupported deadline operation or fields')
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
        write_relay(root)
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
                 'pendingAdmission': None, 'seenAuthorities': [None], 'authorityBootDeadlines': {}, 'nftAuthorities': [None]}
        attest(root, peer, state['program'])
        save(path, state)
        return {'state': 'denied'}
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or stat.S_IMODE(value.st_mode) != 0o600:
        raise ValueError('Untrusted deadline registration')
    state = json.loads(path.read_text())
    if op in ('configure-relay', 'clear-relay', 'prepare'):
        write_relay(root)
    if state['binding'] != binding or state['bootId'] != clocks()['bootId']:
        write_relay(root)
        raise ValueError('Deadline registration is stale')
    if state.get('uncertainExpiry', True):
        write_relay(root)
        write_deadline(root, state['peer']['index'], 0)
        raise ValueError('Uncertain expiry requires a fresh generation')
    if op == 'clear-relay':
        return {'state': 'relay-denied'}
    if op == 'configure-relay':
        registration = request['relay']
        if state.get('relayRegistration', registration) != registration:
            raise ValueError('Relay replacement requires a fresh generation')
        attest(root, state['peer'], state['program'])
        policy = relay_policy(binding, state['peer'], registration)
        if state.get('relayPolicy', policy.hex()) != policy.hex():
            raise ValueError('Relay endpoints changed; fresh generation required')
        state['relayRegistration'] = registration
        state['relayPolicy'] = policy.hex()
        save(path, state)
        try:
            write_relay(root, policy)
            if relay_policy(binding, state['peer'], registration) != policy:
                raise ValueError('Relay changed during configuration')
            attest(root, state['peer'], state['program'])
        except BaseException:
            write_relay(root)
            raise
        return {'state': 'relay-configured'}
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
    # A continuous renewal keeps the old kernel deadline until compare-and-renew.
    # Failure is followed by the caller's explicit revoke; the old lease expires independently.
    if op != 'renew':
        write_deadline(root, state['peer']['index'], 0)
    else:
        previous = request['previousBootDeadlineNs']
        if (not isinstance(previous, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', previous)
                or previous != state.get('lastDeadlineNs') or int(previous) > (1 << 64) - 1
                or request['lease']['revision'] != state['revision']):
            raise ValueError('Invalid continuous deadline renewal')
        remember_expiry(binding, state)
    lease = request['lease']
    deadline, captured, expiry = validate_lease(key, state, lease, pending=True)
    try:
        if endpoint(binding) != state['peer']:
            raise ValueError('Deadline interface changed')
        if state.get('relayRegistration') is not None:
            if relay_policy(binding, state['peer'], state['relayRegistration']).hex() != state['relayPolicy']:
                raise ValueError('Registered relay endpoints changed')
        attest(root, state['peer'], state['program'])
    except BaseException:
        write_relay(root)
        raise
    state['lastDeadlineNs'] = str(deadline)
    state['pendingAdmission'] = None
    state['revision'] = lease['revision']
    state['lastCapturedNs'] = str(captured)
    state['authorityExpiresAt'] = expiry
    remember_authority(state, lease)
    for value in lease['authorityBootDeadlines']:
        if int(value) not in state['nftAuthorities']:
            state['nftAuthorities'].append(int(value))
    save(path, state)
    # No remaining duration is recomputed here. An arbitrarily late update stays expired.
    if op == 'renew':
        renew_deadline(root, state['peer']['index'], int(previous), deadline)
    else:
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
        data = sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError('Oversized deadline request')
        print(json.dumps(execute(json.loads(data))))
