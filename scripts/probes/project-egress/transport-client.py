"""Real project-UID client; no host sockets or credentials are mounted here."""
import select
import socket
import sys
import time

address, mode = sys.argv[1:3]
ports = (8080, 8443, 8444)
if mode == 'positive':
    for port in ports:
        with socket.create_connection((address, port), timeout=3) as channel:
            if port == 8080:
                channel.sendall(b'POST /internal/project/memory HTTP/1.1\r\nHost: relay\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                expected = b'project-bound-fixture'
            else:
                channel.sendall(b'probe')
                expected = b'claude.sock' if port == 8443 else b'codex.sock'
            reply = b''
            while expected not in reply:
                part = channel.recv(8192)
                if not part:
                    raise RuntimeError((port, reply))
                reply += part
    print('transport-positive', flush=True)
elif mode == 'negative':
    port = int(sys.argv[3])
    try:
        with socket.create_connection((address, port), timeout=0.4):
            raise RuntimeError('forbidden transport connected')
    except (TimeoutError, ConnectionError, OSError):
        print('transport-denied', flush=True)
elif mode == 'external':
    positive = sys.argv[3] == 'positive'
    for family, target in [(socket.AF_INET, '172.30.105.2'), (socket.AF_INET6, 'fd42:feed:5::2')]:
        for port in (53, 8080):
            with socket.socket(family, socket.SOCK_DGRAM) as channel:
                channel.sendto(f'external-{family}-udp-{port}'.encode(), (target, port))
        with socket.socket(family, socket.SOCK_STREAM) as channel:
            channel.settimeout(0.5)
            try:
                channel.connect((target, 443))
                channel.sendall(f'GET /external-{family}-tcp-own-credential HTTP/1.1\r\nAuthorization: Bearer fixture-own-credential\r\n\r\n'.encode())
                assert b'external-positive' in channel.recv(1024)
                if not positive:
                    raise RuntimeError('direct credential bypass connected')
            except OSError:
                if positive:
                    raise
    print('external-probed', flush=True)
elif mode == 'stream':
    channels = []
    for port in ports:
        channel = socket.create_connection((address, port), timeout=3)
        if port == 8080:
            channel.sendall(b'GET /internal/mcp-proxy HTTP/1.1\r\nHost: relay\r\nContent-Length: 0\r\n\r\n')
        channels.append(channel)
    for _ in range(300):
        if select.select([channels[0]], [], [], 0)[0]:
            data = channels[0].recv(8192)
            if b'transport-stream-marker' in data:
                with open('/work/broker-receipts', 'a') as evidence:
                    evidence.write(str(time.time() * 1000) + '\n')
        for channel in channels[1:]:
            try:
                channel.sendall(b'transport-stream-marker\n')
            except OSError:
                pass
        time.sleep(0.05)
else:
    raise ValueError(mode)
