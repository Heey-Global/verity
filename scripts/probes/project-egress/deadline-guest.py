"""Disposable x86_64 guest prototype; never install on a production host."""
import ctypes
import datetime
import json
import os
from pathlib import Path
import platform
import socket
import struct
import subprocess
import sys
import time

ROOT = Path('/opt/verity-fixture')
PINS = Path('/sys/fs/bpf/verity-deadline-probe')
PEER = 'vdeadline'


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, **kwargs)


def bpf(command, attr):
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.syscall(321, command, ctypes.byref(attr), ctypes.sizeof(attr))
    if result < 0:
        raise OSError(ctypes.get_errno(), 'BPF syscall failed')
    return result


class ObjectAttr(ctypes.Structure):
    _fields_ = [('pathname', ctypes.c_uint64), ('fd', ctypes.c_uint32), ('flags', ctypes.c_uint32)]


class ElementAttr(ctypes.Structure):
    _fields_ = [('fd', ctypes.c_uint32), ('padding', ctypes.c_uint32),
                ('key', ctypes.c_uint64), ('value', ctypes.c_uint64), ('flags', ctypes.c_uint64)]


def element(name, value, update=False):
    pathname = ctypes.create_string_buffer(str(PINS / 'maps' / name).encode())
    fd = bpf(7, ObjectAttr(ctypes.addressof(pathname), 0, 0))
    key = ctypes.c_uint32(0)
    buffer = ctypes.create_string_buffer(value if update else value * b'\0', len(value) if update else value)
    try:
        bpf(2 if update else 1, ElementAttr(fd, 0, ctypes.addressof(key), ctypes.addressof(buffer), 0))
        return buffer.raw
    finally:
        os.close(fd)


def clocks():
    # Record all three clocks; a paused VM is not evidence of actual guest suspend.
    return {'real_ns': time.time_ns(), 'boot_ns': time.clock_gettime_ns(time.CLOCK_BOOTTIME),
            'mono_ns': time.monotonic_ns()}


def setup():
    assert Path('/proc/1/comm').read_text().strip() == 'systemd'
    assert 'verity-boot-probe' in Path('/var/lib/cloud/data/instance-id').read_text()
    run('timedatectl', 'set-ntp', 'false')
    if subprocess.run(['findmnt', '-n', '-o', 'FSTYPE', '/sys/fs/bpf'], capture_output=True, text=True).stdout.strip() != 'bpf':
        run('mount', '-t', 'bpf', 'bpf', '/sys/fs/bpf')
    run('clang', '-O2', '-g', '-target', 'bpf', '-I/usr/include/x86_64-linux-gnu', '-c',
        str(ROOT / 'project-egress-deadline.bpf.c'), '-o', str(ROOT / 'deadline.bpf.o'))
    run('ip', 'netns', 'add', 'deadline-project')
    run('ip', 'link', 'add', PEER, 'type', 'veth', 'peer', 'name', 'deadline-peer')
    run('ip', 'link', 'set', 'deadline-peer', 'netns', 'deadline-project')
    run('ip', 'addr', 'add', '172.30.106.1/24', 'dev', PEER)
    run('ip', 'link', 'set', PEER, 'up')
    run('ip', 'netns', 'exec', 'deadline-project', 'ip', 'addr', 'add', '172.30.106.2/24', 'dev', 'deadline-peer')
    run('ip', 'netns', 'exec', 'deadline-project', 'ip', 'link', 'set', 'deadline-peer', 'up')
    run('ip', 'netns', 'exec', 'deadline-project', 'ip', 'route', 'add', 'default', 'via', '172.30.106.1')
    link = next(p.name for p in Path('/sys/class/net').iterdir()
                if (p / 'address').read_text().strip() == '52:54:00:be:ef:02')
    run('ip', 'link', 'set', link, 'up')
    run('ip', 'addr', 'add', '172.30.105.3/24', 'dev', link)
    run('sysctl', '-w', 'net.ipv4.ip_forward=1')
    run('ip', 'route', 'add', '172.30.105.2/32', 'dev', link)
    PINS.mkdir(mode=0o700)
    (PINS / 'maps').mkdir(mode=0o700)
    run('bpftool', 'prog', 'load', str(ROOT / 'deadline.bpf.o'), str(PINS / 'guard'),
        'type', 'classifier', 'pinmaps', str(PINS / 'maps'))
    run('tc', 'qdisc', 'add', 'dev', PEER, 'clsact')
    for direction in ('ingress', 'egress'):
        run('tc', 'filter', 'add', 'dev', PEER, direction, 'pref', '1', 'handle', '1',
            'bpf', 'da', 'pinned', str(PINS / 'guard'), 'skip_hw')
    return {'clocks': clocks(), 'kernel': run('uname', '-r').strip(),
            'versions': run('dpkg-query', '-W', 'clang', 'libbpf-dev', 'bpftool', 'nftables'),
            'power_states': Path('/sys/power/state').read_text().strip(),
            'program': json.loads(run('bpftool', '-j', 'prog', 'show', 'pinned', str(PINS / 'guard')))}


def arm(duration_ms, delay_ms=0):
    start = clocks()
    deadline = start['boot_ns'] + duration_ms * 1_000_000
    index = int((Path('/sys/class/net') / PEER / 'ifindex').read_text())
    # Capture the deadline BEFORE a deliberately delayed commit.
    time.sleep(delay_ms / 1000)
    element('deadline', struct.pack('<QII', deadline, index, 0), True)
    return {'before': start, 'committed': clocks(), 'deadline_ns': deadline}


def stats():
    possible = Path('/sys/devices/system/cpu/possible').read_text().strip()
    cpus = sum(int(v.split('-')[-1]) - int(v.split('-')[0]) + 1 for v in possible.split(','))
    raw = element('observations', 32 * cpus)
    rows = [struct.unpack_from('<QQQQ', raw, 32 * i) for i in range(cpus)]
    return {'clocks': clocks(), 'accepted': sum(r[0] for r in rows), 'denied': sum(r[1] for r in rows),
            'last_accepted_boot_ns': max(r[2] for r in rows), 'last_denied_boot_ns': max(r[3] for r in rows)}


def nft(deadline_seconds):
    date = datetime.datetime.fromtimestamp(deadline_seconds, datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    rules = f'''table inet deadline_probe {{
counter expired {{ }}
chain forward {{ type filter hook forward priority -200; policy accept;
 iifname "{PEER}" meta time >= "{date}" counter name expired drop
 iifname "{PEER}" ip daddr 172.30.105.2 udp dport 8080 meta time < "{date}" counter accept
 iifname "{PEER}" counter drop
}}
}}'''
    run('nft', '-f', '-', input=rules, env={**os.environ, 'TZ': 'UTC'})
    return {'deadline_real_ns': deadline_seconds * 1_000_000_000, 'rules': rules}


def send(marker):
    channel = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    channel.sendto(marker.encode(), ('172.30.105.2', 8080))
    channel.close()


if __name__ == '__main__':
    assert os.geteuid() == 0 and platform.machine() == 'x86_64'
    assert os.environ.get('PROJECT_EGRESS_DISPOSABLE') == 'yes'
    action = sys.argv[1]
    if action == 'setup':
        result = setup()
    elif action == 'arm':
        result = arm(*map(int, sys.argv[2:]))
    elif action == 'stats':
        result = stats()
    elif action == 'nft':
        result = nft(int(sys.argv[2]))
    elif action == 'nft-stats':
        result = json.loads(run('nft', '-j', 'list', 'table', 'inet', 'deadline_probe'))
    elif action == 'send':
        send(sys.argv[2])
        result = clocks()
    else:
        raise ValueError('Unknown action')
    print(json.dumps(result))
