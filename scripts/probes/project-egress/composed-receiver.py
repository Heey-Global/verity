"""Independent dual-stack receipts for actual composed enforcement, including retained TCP."""
import json
import selectors
import socket
import time

poll = selectors.DefaultSelector()
for family, address in [(socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')]:
    for kind, port in [(socket.SOCK_DGRAM, 8080), (socket.SOCK_STREAM, 443)]:
        channel = socket.socket(family, kind)
        channel.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if family == socket.AF_INET6:
            channel.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        channel.bind((address, port))
        if kind == socket.SOCK_STREAM:
            channel.listen(16)
        channel.setblocking(False)
        poll.register(channel, selectors.EVENT_READ, 'listen' if kind == socket.SOCK_STREAM else 'udp')
print(json.dumps({'kind': 'ready'}), flush=True)
while True:
    for key, _ in poll.select(0.1):
        channel = key.fileobj
        if key.data == 'listen':
            connection, _ = channel.accept()
            connection.setblocking(False)
            poll.register(connection, selectors.EVENT_READ, 'tcp')
            continue
        if key.data == 'udp':
            data, _ = channel.recvfrom(8192)
        else:
            try:
                data = channel.recv(8192)
                if data:
                    channel.sendall(b'external-positive')
            except OSError:
                data = b''
            if not data:
                poll.unregister(channel)
                channel.close()
        if data:
            print(json.dumps({'kind': key.data, 'marker': data.decode(errors='replace'),
                              'boot_ns': str(time.clock_gettime_ns(time.CLOCK_BOOTTIME))}), flush=True)
