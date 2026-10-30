"""Independent outer-host receiver; heartbeat proves observation continued during reboot."""
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import sys
import time


def observe(output, ready):
    poll = selectors.DefaultSelector()
    channels = []
    stopped = False
    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    with open(output, 'w', buffering=1) as log:
        def record(kind, **fields):
            log.write(json.dumps({'kind': kind, 'time_ns': time.time_ns(), 'monotonic_ns': time.monotonic_ns(), **fields}) + '\n')
        try:
            for family, address in [(socket.AF_INET, '172.30.105.2'), (socket.AF_INET6, 'fd42:feed:5::2')]:
                for kind, ports in [(socket.SOCK_DGRAM, [53, 8080]), (socket.SOCK_STREAM, [443, 8080])]:
                    for port in ports:
                        channel = socket.socket(family, kind)
                        channels.append(channel)
                        channel.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        if family == socket.AF_INET6:
                            channel.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                        channel.bind((address, port))
                        if kind == socket.SOCK_STREAM:
                            channel.listen(64)
                        channel.setblocking(False)
                        poll.register(channel, selectors.EVENT_READ, ('listener' if kind == socket.SOCK_STREAM else 'udp', port))
            Path(ready).write_text(str(os.getpid()))
            record('ready')
            heartbeat = 0
            while not stopped:
                now = time.monotonic()
                if now - heartbeat >= 0.1:
                    record('heartbeat')
                    heartbeat = now
                for key, _ in poll.select(0.05):
                    mode, port = key.data
                    if mode == 'listener':
                        conn, peer = key.fileobj.accept()
                        conn.setblocking(False)
                        channels.append(conn)
                        poll.register(conn, selectors.EVENT_READ, ('tcp', port))
                        continue
                    if mode == 'udp':
                        data, peer = key.fileobj.recvfrom(8192)
                    else:
                        data = key.fileobj.recv(8192)
                        peer = key.fileobj.getpeername()
                        if not data:
                            poll.unregister(key.fileobj)
                            key.fileobj.close()
                            continue
                        try:
                            key.fileobj.send(b'external-positive')
                        except OSError:
                            pass
                    record('received', protocol=mode, port=port, peer=list(peer), data=base64.b64encode(data).decode())
            record('stopped')
        finally:
            for channel in channels:
                channel.close()
            poll.close()


if __name__ == '__main__':
    observe(sys.argv[1], sys.argv[2])
