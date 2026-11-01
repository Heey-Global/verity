"""Uninstalled root-only host helper for the experimental packet deadline guard.

No command, program path, namespace path or interface supplied by a Sandbox is
accepted. The trusted host adapter supplies its already registered binding.
"""
import ctypes
import signal
import traceback
import threading
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import stat
import socket
import struct
import subprocess
import sys
import time

STATE = Path('/var/lib/verity-egress/deadline')
PINS = Path('/sys/fs/bpf/verity_egress_deadline')
OBJECT = Path('/opt/verity-egress/project-egress-deadline.bpf.o')
BINDING_FIELDS = ('projectId', 'generation', 'containerId', 'networkId', 'endpointId', 'bridge', 'ipv4', 'ipv6')


DOCKER_SOCKET = '/var/run/docker.sock'


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        # HTTPResponse can own the socket after getresponse clears self.sock.
        self.transport_socket = self.sock
        self.sock.settimeout(self.timeout)
        self.sock.connect(DOCKER_SOCKET)


def docker_inspect(kind, identity):
    if kind not in ('container', 'network') or not re.fullmatch(r'[a-f0-9]{64}', identity):
        raise ValueError('Invalid host Docker inspection identity')
    path = f'/v1.47/{"containers" if kind == "container" else "networks"}/{identity}'
    if kind == 'container':
        path += '/json'
    connection = DockerConnection('localhost', timeout=1)
    expired = threading.Event()
    def expire():
        expired.set()
        channel = getattr(connection, 'transport_socket', None)
        if channel is not None:
            try:
                channel.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()
    timer = threading.Timer(1, expire)
    timer.start()
    response = None
    try:
        connection.request('GET', path, headers={'Connection': 'close'})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError('Host Docker inspection returned HTTP ' + str(response.status))
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError('Oversized host Docker inspection')
        if response.length not in (None, 0):
            raise ValueError('Truncated host Docker inspection')
        value = json.loads(body.decode('utf-8'))
        if expired.is_set():
            raise TimeoutError('Host Docker inspection timed out')
        if not isinstance(value, dict) or value.get('Id') != identity:
            raise ValueError('Invalid host Docker inspection object identity')
        return json.dumps([value])
    finally:
        timer.cancel()
        connection.close()
        timer.join()
        if response is not None:
            response.close()
        channel = getattr(connection, 'transport_socket', None)
        if channel is not None:
            channel.close()



# Linux UAPI layouts are restricted to the existing supported little-endian x86_64 host.
# Sources: include/uapi/linux/{rtnetlink,if_link,pkt_cls,bpf}.h in the Linux tree.
MAX_KERNEL_BYTES = 2 * 1024 * 1024


def kernel_abi():
    if platform.machine() != 'x86_64' or sys.byteorder != 'little' or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise ValueError('Unsupported deadline kernel ABI')


def nft_read(table=None):
    started = time.monotonic()
    kernel_abi()
    if table is not None and not re.fullmatch(r'verity_egress_[a-f0-9]{24}', table):
        raise ValueError('Invalid deadline nft table')
    library = ctypes.CDLL('libnftables.so.1')
    library.nft_ctx_new.argtypes = [ctypes.c_uint32]
    library.nft_ctx_new.restype = ctypes.c_void_p
    library.nft_ctx_free.argtypes = [ctypes.c_void_p]
    library.nft_ctx_free.restype = None
    library.nft_ctx_output_set_flags.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    library.nft_ctx_output_set_flags.restype = None
    for name in ('nft_ctx_buffer_output', 'nft_ctx_buffer_error'):
        getattr(library, name).argtypes = [ctypes.c_void_p]
        getattr(library, name).restype = ctypes.c_int
    library.nft_run_cmd_from_buffer.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    library.nft_run_cmd_from_buffer.restype = ctypes.c_int
    library.nft_ctx_get_output_buffer.argtypes = [ctypes.c_void_p]
    library.nft_ctx_get_output_buffer.restype = ctypes.c_char_p
    context = library.nft_ctx_new(0)
    if not context:
        raise ValueError('Cannot create deadline nft context')
    try:
        library.nft_ctx_output_set_flags(context, 1 << 4)  # NFT_CTX_OUTPUT_JSON
        if library.nft_ctx_buffer_output(context) != 0 or library.nft_ctx_buffer_error(context) != 0:
            raise ValueError('Cannot buffer deadline nft inspection')
        command = 'list ruleset' if table is None else 'list table inet ' + table
        if library.nft_run_cmd_from_buffer(context, command.encode()) != 0:
            raise ValueError('Deadline nft inspection failed')
        if time.monotonic() - started > 1:
            raise TimeoutError('Deadline nft read timed out')
        output = library.nft_ctx_get_output_buffer(context)
        if not output or len(output) > MAX_KERNEL_BYTES:
            raise ValueError('Invalid or oversized deadline nft inspection')
        value = json.loads(output)
        if not isinstance(value, dict) or not isinstance(value.get('nftables'), list) or len(value['nftables']) > 10000:
            raise ValueError('Invalid deadline nft JSON')
        return value
    finally:
        library.nft_ctx_free(context)


def route_attributes(data):
    result = {}
    offset = 0
    while offset < len(data):
        if len(data) - offset < 4:
            raise ValueError('Truncated route attribute header')
        size, raw_kind = struct.unpack_from('<HH', data, offset)
        kind = raw_kind & 0x3fff
        if size < 4 or offset + size > len(data) or raw_kind & 0x4000 or kind in result:
            raise ValueError('Invalid or duplicate route attribute')
        result[kind] = data[offset + 4:offset + size]
        offset += (size + 3) & ~3
        if offset > len(data):
            raise ValueError('Truncated route attribute padding')
    return result


def route_string(value):
    if not value or value[-1:] != b'\0' or b'\0' in value[:-1] or len(value) > 256:
        raise ValueError('Invalid route string')
    return value[:-1].decode('ascii')


def route_u32(value):
    if len(value) != 4:
        raise ValueError('Invalid route integer')
    return struct.unpack('<I', value)[0]


def route_frames(data, sequence, port, expected):
    records = []
    offset = 0
    done = False
    while offset < len(data):
        if len(data) - offset < 16 or done:
            raise ValueError('Truncated or trailing route message')
        size, kind, flags, seq, pid = struct.unpack_from('<IHHII', data, offset)
        if size < 16 or offset + size > len(data) or seq != sequence or pid != port or flags & ~0x22:
            raise ValueError('Invalid, interrupted or foreign route message')
        body = data[offset + 16:offset + size]
        if kind == 3:
            if body not in (b'', bytes(4), bytes(8)):
                raise ValueError('Failed route multipart dump')
            done = True
        elif kind != expected or not flags & 2:
            raise ValueError('Unexpected route response')
        else:
            records.append(body)
        offset += (size + 3) & ~3
        if offset > len(data):
            raise ValueError('Truncated route message padding')
    return records, done


def route_dump(kind, body):
    kernel_abi()
    if kind not in (18, 46):
        raise ValueError('Unsupported deadline route query')
    started = time.monotonic()
    sequence = int.from_bytes(os.urandom(4), 'little') or 1
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE) as channel:
        channel.settimeout(1)
        channel.bind((0, 0))
        port = channel.getsockname()[0]
        channel.sendto(struct.pack('<IHHII', 16 + len(body), kind, 0x301, sequence, port) + body, (0, 0))
        records, count = [], 0
        while True:
            remaining = 1 - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError('Deadline route read timed out')
            channel.settimeout(remaining)
            data, ancillary, flags, sender = channel.recvmsg(65536)
            count += len(data)
            if not data or ancillary or flags or sender != (0, 0) or count > MAX_KERNEL_BYTES:
                raise ValueError('Truncated, oversized or foreign route dump')
            batch, done = route_frames(data, sequence, port, kind - 2)
            records.extend(batch)
            if len(records) > 4096:
                raise ValueError('Too many deadline route objects')
            if done:
                return records


def kernel_links():
    result = []
    for body in route_dump(18, bytes(16)):
        if len(body) < 16:
            raise ValueError('Truncated deadline link')
        family, pad, link_type, index, flags, change = struct.unpack_from('<BBHiII', body)
        if family != 0 or pad != 0 or index <= 0:
            raise ValueError('Unsupported deadline link layout')
        attrs = route_attributes(body[16:])
        name = route_string(attrs[3])
        address = attrs.get(1, b'')
        if len(address) > 32 or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}', name):
            raise ValueError('Unsupported deadline link identity')
        link = {'ifindex': index, 'ifname': name, 'address': address.hex(':')}
        if 5 in attrs:
            link['link_index'] = route_u32(attrs[5])
        if 18 in attrs:
            nested = route_attributes(attrs[18])
            if 1 in nested:
                link['linkinfo'] = {'info_kind': route_string(nested[1])}
        result.append(link)
    return result


def namespace_links(namespace):
    if not re.fullmatch(r'/var/run/docker/netns/[a-zA-Z0-9_-]+', namespace):
        raise ValueError('Invalid deadline namespace path')
    original = os.open('/proc/self/ns/net', os.O_RDONLY | os.O_CLOEXEC)
    target = None
    try:
        target = os.open(namespace, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        for fd in (original, target):
            if fcntl.ioctl(fd, 0xb703) != 0x40000000:  # NS_GET_NSTYPE, CLONE_NEWNET
                raise ValueError('Not a network namespace descriptor')
        before = os.fstat(original)
        try:
            os.setns(target, 0x40000000)
            return kernel_links()
        finally:
            try:
                os.setns(original, 0x40000000)
                after = os.stat('/proc/self/ns/net')
                if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                    raise ValueError('Deadline host namespace restoration mismatch')
            except BaseException as error:
                # The resident process must never accept another request in a project namespace.
                raise SystemExit('Deadline host namespace restoration failed') from error
    finally:
        if target is not None:
            os.close(target)
        os.close(original)


def kernel_filters(index, direction):
    if type(index) is not int or not 0 < index < (1 << 31) or direction not in ('ingress', 'egress'):
        raise ValueError('Invalid deadline hook query')
    parent = 0xfffffff2 if direction == 'ingress' else 0xfffffff3
    result = []
    for body in route_dump(46, struct.pack('<BBHiIII', 0, 0, 0, index, 0, parent, 0)):
        if len(body) < 20:
            raise ValueError('Truncated deadline classifier')
        family, pad, pad2, actual, handle, owner, info = struct.unpack_from('<BBHiIII', body)
        if family != 0 or pad or pad2 or actual != index or owner != parent:
            raise ValueError('Foreign deadline classifier')
        attrs = route_attributes(body[20:])
        if set(attrs) - {1, 2, 3, 4, 6, 7, 9, 11, 12, 16}:
            raise ValueError('Unsupported deadline classifier attributes')
        entry = {'kind': route_string(attrs[1]), 'pref': info >> 16,
                 'protocol': 'all' if socket.ntohs(info & 65535) == 3 else 'unsupported',
                 'chain': route_u32(attrs[11]) if 11 in attrs else 0}
        if 2 in attrs:
            options = route_attributes(attrs[2])
            if set(options) - {7, 8, 9, 10, 11}:
                raise ValueError('Unsupported deadline BPF classifier options')
            direct = route_u32(options[8])
            generic = route_u32(options[9])
            if direct & ~1 or generic & ~0x1f:
                raise ValueError('Unsupported deadline BPF flags')
            entry['options'] = {'id': route_u32(options[11]), 'direct-action': bool(direct & 1),
                                'skip_hw': bool(generic & 1), 'skip_sw': bool(generic & 2),
                                'in_hw': bool(generic & 4)}
        result.append(entry)
    return result


class InfoAttr(ctypes.Structure):
    _fields_ = [('fd', ctypes.c_uint32), ('info_len', ctypes.c_uint32), ('info', ctypes.c_uint64)]


def kernel_program(root):
    kernel_abi()
    pathname = ctypes.create_string_buffer(str(root / 'guard').encode())
    fd = bpf(7, ObjectAttr(ctypes.addressof(pathname), 0, 0))
    info = ctypes.create_string_buffer(256)
    attr = InfoAttr(fd, len(info), ctypes.addressof(info))
    try:
        bpf(15, attr)  # BPF_OBJ_GET_INFO_BY_FD
        if attr.info_len < 8:
            raise ValueError('Truncated deadline program identity')
        kind, identity = struct.unpack_from('<II', info.raw)
        return {'id': identity, 'type': 'sched_cls' if kind == 3 else 'unsupported'}
    finally:
        os.close(fd)


def run(*args):
    if args[0] == '/usr/bin/docker':
        if len(args) < 4 or args[2] != 'inspect':
            raise ValueError('Unsupported deadline Docker operation')
        return json.dumps([json.loads(docker_inspect(args[1], identity))[0] for identity in args[3:]])
    if args == ('/sbin/ip', '-j', '-d', 'link', 'show'):
        return json.dumps(kernel_links())
    if len(args) == 6 and args[:1] == ('/usr/bin/nsenter',) and args[2:] == ('/sbin/ip', '-j', 'link', 'show'):
        if not args[1].startswith('--net='):
            raise ValueError('Invalid deadline namespace read')
        return json.dumps(namespace_links(args[1][6:]))
    if args == ('/usr/sbin/nft', '-j', 'list', 'ruleset'):
        return json.dumps(nft_read())
    if len(args) == 6 and args[:5] == ('/usr/sbin/nft', '-j', 'list', 'table', 'inet'):
        return json.dumps(nft_read(args[5]))
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=5,
                                       env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'DOCKER_HOST': 'unix:///var/run/docker.sock'})
    except subprocess.CalledProcessError as error:
        print(error.output[-8192:], file=sys.stderr)
        raise


class InspectionFacts:
    """Fresh, phase-local daemon and link inventory; never retained in registration state."""
    def __init__(self, binding, relay_id=None):
        binding_key(binding)
        self.network_id = binding['networkId']
        self.ids = [binding['containerId']]
        if relay_id is not None:
            if (not isinstance(relay_id, str) or not re.fullmatch(r'[a-f0-9]{64}', relay_id)
                    or relay_id in self.ids):
                raise ValueError('Invalid inspected relay identity')
            self.ids.append(relay_id)
        self._containers = None
        self._network = None
        self._host_links = None
        self.peers = {}

    def container(self, identity):
        if identity not in self.ids:
            raise ValueError('Container outside inspected phase')
        if self._containers is None:
            values = json.loads(run('/usr/bin/docker', 'container', 'inspect', *self.ids))
            if (not isinstance(values, list) or len(values) != len(self.ids)
                    or {value.get('Id') for value in values} != set(self.ids)):
                raise ValueError('Deadline inspected container identity mismatch')
            self._containers = {value['Id']: value for value in values}
        return self._containers[identity]

    def network(self, identity):
        if identity != self.network_id:
            raise ValueError('Network outside inspected phase')
        if self._network is None:
            values = json.loads(run('/usr/bin/docker', 'network', 'inspect', identity))
            if not isinstance(values, list) or len(values) != 1 or values[0].get('Id') != identity:
                raise ValueError('Deadline inspected network identity mismatch')
            self._network = values[0]
        return self._network

    def host_links(self):
        if self._host_links is None:
            self._host_links = json.loads(run('/sbin/ip', '-j', '-d', 'link', 'show'))
        return self._host_links


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


def prepare_renewal(root):
    program = root / 'renew'
    obj = OBJECT.with_name('project-egress-renew.bpf.o')
    value = obj.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
        raise ValueError('Untrusted deadline renewal object')
    if not program.exists():
        run('/usr/sbin/bpftool', 'prog', 'load', str(obj), str(program),
            'map', 'name', 'deadline', 'pinned', str(root / 'maps/deadline'))
    program_info = json.loads(run('/usr/sbin/bpftool', '-j', 'prog', 'show', 'pinned', str(program)))
    map_info = json.loads(run('/usr/sbin/bpftool', '-j', 'map', 'show', 'pinned', str(root / 'maps/deadline')))
    if isinstance(program_info, list):
        program_info = program_info[0]
    if isinstance(map_info, list):
        map_info = map_info[0]
    if program_info['type'] != 'socket_filter' or program_info['map_ids'] != [map_info['id']]:
        raise ValueError('Renewal program is not bound to the deadline map')


def renew_deadline(root, index, previous, deadline):
    program = root / 'renew'
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


def relay_policy(binding, peer, registration, facts=None):
    if (not isinstance(registration, dict)
            or set(registration) != {'containerId', 'endpointId', 'codex'}
            or type(registration['codex']) is not bool
            or any(not isinstance(registration[k], str) or not re.fullmatch(r'[a-f0-9]{64}', registration[k])
                   for k in ('containerId', 'endpointId'))
            or registration['containerId'] == binding['containerId']):
        raise ValueError('Invalid registered relay identity')
    facts = facts if facts is not None else InspectionFacts(binding, registration['containerId'])
    network = facts.network(binding['networkId'])
    if set(network['Containers']) != {binding['containerId'], registration['containerId']}:
        raise ValueError('Relay requires exactly the registered project pair')
    sandbox = facts.container(binding['containerId'])
    relay = facts.container(registration['containerId'])
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
    if endpoint(binding, facts) != peer:
        raise ValueError('Relay sandbox interface changed')
    relay_peer = endpoint(relay_binding, facts)
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


def endpoint(binding, facts=None):
    facts = facts if facts is not None else InspectionFacts(binding)
    key = binding_key(binding)
    if key in facts.peers:
        return facts.peers[key]
    container = facts.container(binding['containerId'])
    network = facts.network(binding['networkId'])
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
    candidates = [v for v in facts.host_links()
                  if v['ifindex'] == links[0].get('link_index')]
    if len(candidates) != 1 or candidates[0].get('linkinfo', {}).get('info_kind') != 'veth':
        raise ValueError('Deadline requires an inspected software veth')
    peer = candidates[0]
    path = Path('/sys/class/net') / peer['ifname']
    if (int((path / 'iflink').read_text()) != links[0]['ifindex']
            or (path / 'master').resolve().name != binding['bridge']):
        raise ValueError('Deadline bridge peer changed')
    result = {'device': peer['ifname'], 'index': peer['ifindex']}
    facts.peers[key] = result
    return result


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
    program = kernel_program(root)
    if isinstance(program, list):
        program = program[0]
    if program['id'] != identity or program['type'] != 'sched_cls':
        raise ValueError('Deadline program identity changed')
    for direction in ('ingress', 'egress'):
        filters = kernel_filters(peer['index'], direction)
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
        prepare_renewal(root)
        write_relay(root)
        # A dedicated veth with unknown classifiers is unsupported, not overwritten.
        qdisc = json.loads(run('/sbin/tc', '-j', 'qdisc', 'show', 'dev', peer['device']))
        if any(q.get('kind') == 'clsact' for q in qdisc):
            raise ValueError('Unexpected existing deadline qdisc')
        run('/sbin/tc', 'qdisc', 'add', 'dev', peer['device'], 'clsact')
        for direction in ('ingress', 'egress'):
            run('/sbin/tc', 'filter', 'add', 'dev', peer['device'], direction, 'pref', '1',
                'handle', '1', 'bpf', 'da', 'pinned', str(root / 'guard'), 'skip_hw')
        program = kernel_program(root)
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
        if op == 'prepare':
            write_deadline(root, state['peer']['index'], 0)
            prepare_renewal(root)
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
        registration = state.get('relayRegistration')
        facts = InspectionFacts(binding, registration['containerId'] if registration is not None else None)
        if endpoint(binding, facts) != state['peer']:
            raise ValueError('Deadline interface changed')
        if state.get('relayRegistration') is not None:
            if relay_policy(binding, state['peer'], state['relayRegistration'], facts).hex() != state['relayPolicy']:
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


def locked_execute(request):
    private_directory(STATE)
    lock = os.open(STATE / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    value = os.fstat(lock)
    if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or stat.S_IMODE(value.st_mode) != 0o600:
        os.close(lock)
        raise ValueError('Untrusted deadline lock')
    with os.fdopen(lock, 'w') as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        return execute(request)


def serve_worker(source, destination):
    previous = 0
    while True:
        data = source.readline(65537)
        if not data:
            return
        if len(data) > 65536 or not data.endswith(b'\n'):
            raise ValueError('Oversized or incomplete deadline frame')
        envelope = json.loads(data.decode('utf-8'))
        if (not isinstance(envelope, dict) or set(envelope) != {'id', 'request'}
                or type(envelope['id']) is not int or envelope['id'] != previous + 1 or envelope['id'] > 9007199254740991
                or not isinstance(envelope['request'], dict)):
            raise ValueError('Invalid deadline frame identity')
        previous = envelope['id']
        started = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
        try:
            response = {'id': previous, 'result': locked_execute(envelope['request'])}
        except Exception:
            traceback.print_exc(file=sys.stderr)
            response = {'id': previous, 'error': True}
        response['startedBootNs'] = str(started)
        response['finishedBootNs'] = str(time.clock_gettime_ns(time.CLOCK_BOOTTIME))
        output = json.dumps(response).encode('utf-8') + b'\n'
        if len(output) > 16384:
            raise ValueError('Oversized deadline reply')
        destination.write(output)
        destination.flush()


def bind_controller():
    parent = os.getppid()
    # Private pipes confer no authority to outlive the owning controller.
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'Cannot bind deadline worker to controller')
    if os.getppid() != parent or parent == 1:
        raise RuntimeError('Deadline controller exited during worker startup')


if __name__ == '__main__':
    if os.geteuid() != 0 or platform.machine() != 'x86_64':
        raise RuntimeError('Deadline helper requires the supported rootful x86_64 host')
    if sys.argv[1:] == ['--worker']:
        bind_controller()
        serve_worker(sys.stdin.buffer, sys.stdout.buffer)
    elif not sys.argv[1:]:
        data = sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError('Oversized deadline request')
        print(json.dumps(locked_execute(json.loads(data))))
    else:
        raise ValueError('Unsupported deadline helper mode')
