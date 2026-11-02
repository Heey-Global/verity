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
elif mode == 'dns':
    # Real queries to the relay's controlled answerer: UDP and TCP, both families.
    name, expected = sys.argv[3], sys.argv[4:]

    def ask(qtype, transport):
        query = (bytes.fromhex('5ee501000001000000000000')
                 + b''.join(bytes([len(label)]) + label.encode() for label in name.split('.'))
                 + b'\0' + qtype.to_bytes(2, 'big') + b'\0\1')
        if transport == 'udp':
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as channel:
                channel.settimeout(3)
                channel.sendto(query, (address, 53))
                reply = channel.recv(4096)
        else:
            with socket.create_connection((address, 53), timeout=3) as channel:
                channel.sendall(len(query).to_bytes(2, 'big') + query)
                reply = b''
                while len(reply) < 2 or len(reply) < 2 + int.from_bytes(reply[:2], 'big'):
                    part = channel.recv(4096)
                    if not part:
                        raise RuntimeError(('dns tcp closed', reply))
                    reply += part
                reply = reply[2:]
        if reply[:2] != query[:2] or not reply[2] & 0x80:
            raise RuntimeError(('dns reply mismatch', reply))
        rcode, count, offset, found = reply[3] & 0x0f, int.from_bytes(reply[6:8], 'big'), len(query), []
        for _ in range(count):
            rtype, length = int.from_bytes(reply[offset + 2:offset + 4], 'big'), int.from_bytes(reply[offset + 10:offset + 12], 'big')
            data = reply[offset + 12:offset + 12 + length]
            found.append(socket.inet_ntop(socket.AF_INET if rtype == 1 else socket.AF_INET6, data))
            offset += 12 + length
        return rcode, found

    for transport in ('udp', 'tcp'):
        for qtype, family in ((1, socket.AF_INET), (28, socket.AF_INET6)):
            rcode, found = ask(qtype, transport)
            if expected:
                wanted = [a for a in expected if (':' in a) == (family == socket.AF_INET6)]
                if rcode != 0 or found != wanted:
                    raise RuntimeError(('dns granted mismatch', transport, qtype, rcode, found))
            elif rcode != 5 or found:
                raise RuntimeError(('dns refusal mismatch', transport, qtype, rcode, found))
    print('dns-granted' if expected else 'dns-refused', flush=True)
elif mode == 'stream':
    channels = []
    for port in ports:
        channel = socket.create_connection((address, port), timeout=3)
        if port == 8080:
            channel.sendall(b'GET /internal/mcp-proxy HTTP/1.1\r\nHost: relay\r\nContent-Length: 0\r\n\r\n')
        channels.append(channel)
    for _ in range(1200):
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
        with open('/work/stream-alive-' + sys.argv[3], 'w') as heartbeat:
            heartbeat.write(str(time.time() * 1000))
        time.sleep(0.05)
else:
    raise ValueError(mode)
