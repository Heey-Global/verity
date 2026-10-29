"""Independent dual-stack receiver; logs the bytes that actually arrived."""
import selectors
import socket

poll = selectors.DefaultSelector()
for family, address in [(socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')]:
    for kind, ports in [(socket.SOCK_DGRAM, [53, 8080]), (socket.SOCK_STREAM, [443, 8080])]:
        for port in ports:
            channel = socket.socket(family, kind)
            channel.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if family == socket.AF_INET6:
                channel.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            channel.bind((address, port))
            if kind == socket.SOCK_STREAM:
                channel.listen(16)
            channel.setblocking(False)
            poll.register(channel, selectors.EVENT_READ, kind)
print('ready', flush=True)
while True:
    for key, _ in poll.select():
        if key.data == socket.SOCK_DGRAM:
            data, _ = key.fileobj.recvfrom(8192)
        else:
            conn, _ = key.fileobj.accept()
            conn.settimeout(0.5)
            try:
                data = conn.recv(8192)
                conn.sendall(b'external-positive')
            except OSError:
                data = b''
            conn.close()
        if data:
            print(data.decode(errors='replace'), flush=True)
