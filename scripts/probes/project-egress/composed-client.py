"""Project-UID sender for the composed startup/TC/nft path; receiver is independent."""
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
        end = time.monotonic() + 4
        attempts = 0
        while time.monotonic() < end:
            attempts += 1
            try:
                channel.sendall((phase + '-retained').encode())
                channel.recv(1024)
            except OSError:
                pass
            Path('/work/composed-stream.json').write_text(json.dumps({
                'attempts': attempts, 'boot_ns': str(time.clock_gettime_ns(time.CLOCK_BOOTTIME))}))
            time.sleep(0.05)
    raise SystemExit(0)
with socket.socket(family, socket.SOCK_DGRAM) as channel:
    channel.sendto((phase + '-udp').encode(), (target, 8080))
with socket.socket(family, socket.SOCK_STREAM) as channel:
    channel.settimeout(0.4)
    try:
        channel.connect((target, 443))
        channel.sendall((phase + '-tcp').encode())
        assert b'external-positive' in channel.recv(1024)
    except OSError:
        if expectation == 'positive':
            raise
    else:
        if expectation != 'positive':
            raise RuntimeError('Denied direct connection reached receiver')
