"""Project-UID sender for the composed startup/TC/nft path; receiver is independent."""
import errno
import json
from pathlib import Path
import time
import socket
import sys

target, phase, expectation = sys.argv[1:]
family = socket.AF_INET6 if ':' in target else socket.AF_INET
if expectation == 'stream':
    with socket.socket(family, socket.SOCK_STREAM) as channel:
        channel.settimeout(0.1)
        channel.connect((target, 443))
        end = time.monotonic() + 60
        stop = Path('/work/composed-stream-stop')
        attempts = 0
        while time.monotonic() < end and not stop.exists():
            attempts += 1
            try:
                channel.sendall((phase + '-retained').encode())
                channel.recv(1024)
            except OSError:
                pass
            temporary = Path('/work/composed-stream.pending')
            temporary.write_text(json.dumps({
                'attempts': attempts, 'boot_ns': str(time.clock_gettime_ns(time.CLOCK_BOOTTIME))}))
            temporary.replace('/work/composed-stream.json')
            time.sleep(0.05)
    raise SystemExit(0)
with socket.socket(family, socket.SOCK_DGRAM) as channel:
    channel.sendto((phase + '-udp').encode(), (target, 8080))
with socket.socket(family, socket.SOCK_STREAM) as channel:
    # A short timeout can leave UDP queued during gateway neighbor resolution.
    initial_denial = expectation == 'negative' and phase.startswith('before-admission-')
    channel.settimeout(4 if initial_denial else 0.4)
    try:
        channel.connect((target, 443))
        channel.sendall((phase + '-tcp').encode())
        assert b'external-positive' in channel.recv(1024)
    except OSError as error:
        if initial_denial:
            if error.errno != errno.EHOSTUNREACH:
                raise RuntimeError('Initial negative probe did not finish neighbor resolution') from error
            print(json.dumps({'phase': phase, 'family': 6 if family == socket.AF_INET6 else 4,
                              'terminal': 'EHOSTUNREACH'}))
        if expectation == 'positive':
            raise
    else:
        if expectation != 'positive':
            raise RuntimeError('Denied direct connection reached receiver')
