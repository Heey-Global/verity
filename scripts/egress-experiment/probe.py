#!/usr/bin/env python3
"""Disposable namespace experiment. No remote endpoints or host network changes.

The controller is outside child namespaces, NOT a production trust anchor.
JSON results deliberately distinguish observations from security certification.
"""
import argparse
import array
import contextlib
import ctypes
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid

SCRIPT = str(Path(__file__).resolve())
UNSHARE = ["unshare", "--user", "--map-current-user", "--net", "--pid",
           "--fork", "--mount-proc"]


def packet(token, dns=False):
    if not dns:
        return (token + "\n").encode()
    labels = [token.encode(), b"invalid"]
    return (struct.pack("!6H", 1, 256, 1, 0, 0, 0)
            + b"".join(bytes([len(x)]) + x for x in labels) + b"\0\0\1\0\1")


def transmit(address, port, token, udp=False, dns=False):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    with socket.socket(family, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        s.connect((address, port))
        s.sendall(packet(token, dns))


class Receiver:
    """Independent receiving thread; sender return codes are not evidence."""
    def __init__(self, address, udp=False):
        self.udp = udp
        self.data = bytearray()
        self.closed_data = bytearray()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        self.server = socket.socket(family, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM)
        self.server.bind((address, 0))
        self.port = self.server.getsockname()[1]
        if not udp:
            self.server.listen(8)
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        connections = []
        received = {}
        try:
            while not self.stop.is_set():
                readable, _, _ = select.select([self.server] + connections, [], [], 0.05)
                for s in readable:
                    if s is self.server and not self.udp:
                        connection, _ = s.accept()
                        connections.append(connection)
                        received[connection] = bytearray()
                        continue
                    data = s.recv(4096)
                    if data:
                        with self.lock:
                            # Bound memory even if a fixture misbehaves.
                            if len(self.data) < 1024 * 1024:
                                self.data.extend(data)
                                if not self.udp:
                                    received[s].extend(data)
                    elif s is not self.server:
                        connections.remove(s)
                        with self.lock:
                            self.closed_data.extend(received.pop(s))
                        s.close()
        finally:
            for s in connections:
                s.close()

    def saw(self, token, timeout=0.2, closed=False):
        deadline = time.monotonic() + timeout
        while True:
            with self.lock:
                if token.encode() in (self.closed_data if closed else self.data):
                    return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.01)

    def close(self):
        self.stop.set()
        self.thread.join(1)
        self.server.close()


class Broker:
    """Fixed-target fixture. Identity belongs to a socket endpoint, not a JSON label."""
    def __init__(self, port):
        self.port = port
        self.allowed = set()
        self.generation = 1
        self.available = True
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.peers = {}
        self.streams = {}
        self.thread = None

    def attach(self, identity, channel):
        self.peers[channel] = (identity, self.generation)

    def start(self):
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def policy(self, allowed, rotate=False, available=True):
        with self.lock:
            self.allowed = set(allowed)
            self.available = available
            if rotate:
                self.generation += 1
            # Revoke existing upstream streams as well as new admissions.
            for peer, stream in list(self.streams.items()):
                identity, generation = self.peers[peer]
                if not available or identity not in self.allowed or generation != self.generation:
                    with contextlib.suppress(OSError):
                        stream.shutdown(socket.SHUT_RDWR)
                    stream.close()
                    del self.streams[peer]

    def run(self):
        while not self.stop.is_set():
            readable, _, _ = select.select(list(self.peers), [], [], 0.05)
            for peer in readable:
                raw = peer.recv(4096)
                if not raw:
                    continue
                try:
                    request = json.loads(raw)
                    with self.lock:
                        identity, generation = self.peers[peer]
                        admitted = (self.available and identity in self.allowed
                                    and generation == self.generation)
                        if admitted:
                            stream = self.streams.get(peer)
                            if stream is None:
                                stream = socket.create_connection(("127.0.0.1", self.port), 0.4)
                                self.streams[peer] = stream
                            stream.sendall(packet(request["token"]))
                    peer.send(json.dumps({"admitted": admitted}).encode())
                except (OSError, ValueError, KeyError):
                    with contextlib.suppress(OSError):
                        peer.send(b'{"admitted":false}')

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(1)
        self.policy([])
        for peer in self.peers:
            peer.close()


def worker():
    broker = socket.socket(fileno=int(sys.argv[2]))
    inherited = socket.socket(fileno=int(sys.argv[3]))
    print(json.dumps({"ready": True, "uid": os.getuid(), "pid": os.getpid(),
                      "netns": os.readlink('/proc/self/ns/net'),
                      "interfaces": socket.if_nameindex()}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        try:
            kind = request['kind']
            token = request['token']
            if kind == 'proxy':
                broker.settimeout(0.5)
                broker.send(json.dumps(request).encode())
                response = json.loads(broker.recv(4096))
            elif kind == 'inherited':
                inherited.sendall(packet(token))
                response = {"sent": True}
            elif kind == 'transfer':
                with socket.socket(socket.AF_UNIX) as ipc:
                    ipc.settimeout(0.5)
                    ipc.connect(request['path'])
                    _, ancillary, _, _ = ipc.recvmsg(1, socket.CMSG_SPACE(4))
                    descriptors = array.array('i')
                    for level, type_, data in ancillary:
                        if level == socket.SOL_SOCKET and type_ == socket.SCM_RIGHTS:
                            descriptors.frombytes(data[:len(data) - len(data) % descriptors.itemsize])
                    if not descriptors:
                        raise RuntimeError('no transferred descriptor')
                    with socket.socket(fileno=descriptors[0]) as connection:
                        connection.sendall(packet(token))
                    for fd in descriptors[1:]:
                        os.close(fd)
                response = {"sent": True}
            elif kind == 'process':
                # Only the controller's own synthetic namespace handle is targeted.
                with open(request['path'], 'rb') as ns:
                    libc = ctypes.CDLL(None, use_errno=True)
                    result = libc.setns(ns.fileno(), 0)
                    response = {"setns": result, "errno": ctypes.get_errno()}
            elif kind == 'shared-file':
                response = {"read": Path(request['path']).read_text() == token}
            elif kind == 'shell':
                result = subprocess.run(['sh', '-c', 'exec "$@"', 'probe', sys.executable,
                                         SCRIPT, 'send', json.dumps(request)], timeout=2,
                                        capture_output=True)
                response = {"exit": result.returncode}
            elif kind == 'package':
                result = subprocess.run(['npm', '--offline', '--prefix', request['path'],
                                         'run', 'probe', '--silent'], timeout=4,
                                        env={**os.environ, 'EGRESS_TEST_REQUEST': json.dumps(request)},
                                        capture_output=True)
                response = {"exit": result.returncode}
            elif kind == 'mcp':
                # Minimal local MCP stdio fixture: a tool child attempts the same direct socket.
                result = subprocess.run([sys.executable, SCRIPT, 'mcp'],
                                        input=json.dumps({'jsonrpc': '2.0', 'id': 1,
                                                          'method': 'tools/call',
                                                          'params': request}),
                                        text=True, capture_output=True, timeout=2)
                response = {"exit": result.returncode}
            else:
                transmit(request['address'], request['port'], token,
                         request.get('udp', False), request.get('dns', False))
                response = {"sent": True}
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            response = {"error": type(error).__name__}
        print(json.dumps(response), flush=True)


class Session:
    def __init__(self, name, isolated, broker, receiver):
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        old = socket.create_connection(('127.0.0.1', receiver.port), 0.5)
        broker.attach(name, parent)
        command = (UNSHARE if isolated else []) + [sys.executable, SCRIPT, 'worker',
                                                  str(child.fileno()), str(old.fileno())]
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.DEVNULL, text=True,
                                            pass_fds=(child.fileno(), old.fileno()), start_new_session=True)
            self.metadata = self.read()
        except BaseException:
            if hasattr(self, "process"):
                self.close()
            raise
        finally:
            child.close()
            old.close()

    def read(self):
        ready, _, _ = select.select([self.process.stdout], [], [], 6)
        if not ready:
            raise RuntimeError('fixture timed out')
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('fixture exited before response')
        return json.loads(line)

    def request(self, value):
        self.process.stdin.write(json.dumps(value) + '\n')
        self.process.stdin.flush()
        return self.read()

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=2)
        self.process.stdin.close()
        self.process.stdout.close()


def preflight():
    if not shutil.which("unshare"):
        return {"exit": 127, "detail": "unshare is unavailable"}
    result = subprocess.run(UNSHARE + [sys.executable, '-c',
        "import os,socket,json;print(json.dumps({'uid':os.getuid(),'pid':os.getpid(),"
        "'netns':os.readlink('/proc/self/ns/net'),'interfaces':socket.if_nameindex()}))"],
        timeout=5, capture_output=True, text=True)
    return {"exit": result.returncode, "detail": result.stdout.strip() or result.stderr.strip()}


def run():
    report = {"schema": 1, "runtime": "current execution environment; host runtime unverified",
              "tools": {name: bool(shutil.which(name)) for name in ('docker', 'runsc', 'runc', 'unshare', 'npm')},
              "preflight": preflight(), "cases": [], "protectedEgressReady": False}
    if report['preflight']['exit'] != 0:
        report['blocked'] = 'User/network/PID/mount namespace fixture unavailable'
        return report
    with tempfile.TemporaryDirectory(prefix='egress-', dir=os.environ.get('TMPDIR')) as directory:
        root = Path(directory)
        (root / 'package.json').write_text(json.dumps({'scripts': {'probe':
            'python3 "' + SCRIPT + '" env-send'}}))
        receivers = {}
        try:
            for label, address, udp in [('tcp4', '127.0.0.1', False), ('tcp6', '::1', False),
                                        ('udp4', '127.0.0.1', True), ('udp6', '::1', True),
                                        ('dns', '127.0.0.1', True)]:
                try:
                    receivers[label] = (Receiver(address, udp), address, udp)
                except OSError as error:
                    report['cases'].append({'case': label, 'status': 'not-run', 'reason': type(error).__name__})
            tcp = receivers['tcp4'][0]
            for isolated in (False, True):
                broker = Broker(tcp.port)
                sessions = []
                mode = 'isolated' if isolated else 'baseline'
                try:
                    for name in ('A', 'B'):
                        sessions.append(Session(name, isolated, broker, tcp))
                    broker.start()
                    report[mode] = [s.metadata for s in sessions]
                    def attempt(name, index, receiver=tcp, expected=False, **request):
                        token = uuid.uuid4().hex
                        response = sessions[index].request({**request, 'token': token})
                        observed = receiver.saw(token)
                        report['cases'].append({'case': mode + '/' + name, 'observed': observed,
                            'expected': expected, 'status': 'pass' if observed == expected else 'violation',
                            'response': response})
                        return token
                    for label, (receiver, address, udp) in receivers.items():
                        for index, name in enumerate(('A', 'B')):
                            attempt(label + '/' + name, index, receiver, not isolated, kind='direct',
                                    address=address, port=receiver.port, udp=udp, dns=label == 'dns')
                    for kind in ('shell', 'package', 'mcp'):
                        if kind == 'package' and not shutil.which('npm'):
                            report['cases'].append({'case': mode + '/package', 'status': 'not-run'})
                        else:
                            attempt(kind, 1, expected=not isolated, kind=kind, path=str(root),
                                    address='127.0.0.1', port=tcp.port)
                    if not isolated:
                        continue
                    for index, name in enumerate(('A', 'B')):
                        attempt('no-grant/' + name, index, kind='proxy')
                    broker.policy(['A'])
                    attempt('A-approved', 0, expected=True, kind='proxy')
                    attempt('B-forged-label', 1, kind='proxy', identity='A', generation=1)
                    attempt('A-after-B', 0, expected=True, kind='proxy')
                    broker.policy(['B'])
                    attempt('B-positive-control', 1, expected=True, kind='proxy')
                    broker.policy(['A'])
                    stream_token = attempt('A-stream-before-revoke', 0, expected=True, kind='proxy')
                    started = time.monotonic()
                    broker.policy([])
                    closed = tcp.saw(stream_token, timeout=2, closed=True)
                    elapsed = time.monotonic() - started
                    report['cases'].append({'case': 'isolated/upstream-stream-closed-on-revoke',
                        'status': 'pass' if closed and elapsed <= 2 else 'violation',
                        'observedEOF': closed, 'seconds': elapsed})
                    attempt('A-after-revoke', 0, kind='proxy')
                    broker.policy(['A'])
                    attempt('A-before-generation', 0, expected=True, kind='proxy')
                    broker.policy(['A'], rotate=True)
                    attempt('stale-generation', 0, kind='proxy')
                    broker.policy([], available=False)
                    attempt('gateway-unavailable', 0, kind='proxy')
                    broker.policy([], rotate=True)
                    attempt('gateway-reset-no-grant', 0, kind='proxy')
                    broker.stop.set()
                    broker.thread.join(1)
                    attempt('gateway-stopped', 0, kind='proxy')
                    # Deliberately retained network descriptors show why namespace creation alone is insufficient.
                    attempt('B-inherited-network-descriptor', 1, kind='inherited')
                    path = str(root / 'transfer.sock')
                    with socket.socket(socket.AF_UNIX) as listener:
                        listener.bind(path)
                        listener.listen(1)
                        listener.settimeout(2)
                        connection = socket.create_connection(('127.0.0.1', tcp.port), 0.5)
                        def transfer():
                            try:
                                with listener.accept()[0] as ipc:
                                    ipc.sendmsg([b'x'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                                         array.array('i', [connection.fileno()]))])
                            except OSError:
                                pass
                        sender = threading.Thread(target=transfer)
                        sender.start()
                        try:
                            attempt('B-shared-IPC-network-descriptor', 1, kind='transfer', path=path)
                        finally:
                            sender.join(3)
                            connection.close()
                    marker = root / 'identity'
                    token = uuid.uuid4().hex
                    marker.write_text(token)
                    response = sessions[1].request({'kind': 'shared-file', 'path': str(marker), 'token': token})
                    report['cases'].append({'case': 'isolated/shared-file-identity-is-untrusted',
                                            'status': 'observed', 'response': response})
                    response = sessions[1].request({'kind': 'process', 'token': '',
                                                    'path': f'/proc/{os.getpid()}/ns/net'})
                    report['cases'].append({'case': 'isolated/controller-netns-access',
                        'status': 'violation' if response.get('setns') == 0 else 'blocked-attempt',
                        'response': response})
                finally:
                    for session in sessions:
                        session.close()
                    broker.close()
            for label, (receiver, address, udp) in receivers.items():
                token = uuid.uuid4().hex
                transmit(address, receiver.port, token, udp, label == 'dns')
                report['cases'].append({'case': 'observer-final-control/' + label,
                    'status': 'pass' if receiver.saw(token) else 'violation'})
        finally:
            for receiver, _, _ in receivers.values():
                receiver.close()
    report['cases'].extend({'case': name, 'status': 'not-run', 'reason': reason} for name, reason in [
        ('QUIC', 'No QUIC fixture; UDP is not a QUIC result'),
        ('separate-containers', 'No configured disposable Docker host was used'),
        ('host-gVisor-runc-matrix', 'Host runtime/version and production launch parameters not attested'),
        ('real-supervisor-restart', 'Policy reset and broker thread stop only; no host supervisor restart')])
    report['decision'] = 'Evaluate per-case observations and positive controls; retained/shared socket capabilities and host trust remain separate gates. No production trust-boundary certification.'
    return report


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'worker':
        worker()
    elif len(sys.argv) > 1 and sys.argv[1] in ('send', 'env-send', 'mcp'):
        mode = sys.argv[1]
        value = (json.loads(sys.argv[2]) if mode == 'send' else
                 json.loads(os.environ['EGRESS_TEST_REQUEST']) if mode == 'env-send' else
                 json.load(sys.stdin)['params'])
        try:
            transmit(value['address'], value['port'], value['token'])
        except OSError:
            sys.exit(1)
    else:
        parser = argparse.ArgumentParser()
        parser.add_argument('--output', required=True)
        args = parser.parse_args()
        def interrupted(signum, _frame):
            raise InterruptedError(f'Experiment interrupted by signal {signum}')
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        result = run()
        Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'output': args.output, 'cases': len(result['cases']),
                          'protectedEgressReady': False}))
        sys.exit(2 if result.get('blocked') else 0)
