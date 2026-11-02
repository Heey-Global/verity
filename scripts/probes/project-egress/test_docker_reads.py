"""Actual Unix HTTP boundary tests for the short-lived deadline helper."""
import importlib.util
import json
from pathlib import Path
import socketserver
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.py'
spec = importlib.util.spec_from_file_location('docker_deadline_host', source)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


@contextmanager
def daemon(reply):
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            request = self.rfile.readline().decode()
            while self.rfile.readline() not in (b'\r\n', b''):
                pass
            try:
                reply(self, request)
            except (BrokenPipeError, ConnectionResetError):
                pass
    with tempfile.TemporaryDirectory(prefix='ed-', dir='/tmp') as directory:
        path = directory + '/docker.sock'
        with socketserver.ThreadingUnixStreamServer(path, Handler) as server:
            server.daemon_threads = True
            worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01))
            worker.start()
            try:
                with patch.object(host, 'DOCKER_SOCKET', path):
                    yield
            finally:
                server.shutdown()
                worker.join(timeout=2)


class DockerReadTests(unittest.TestCase):
    identity = 'a' * 64

    def test_maps_fixed_routes_and_keeps_cli_array_shape(self):
        for kind, path in [('container', '/containers/' + self.identity + '/json'),
                           ('network', '/networks/' + self.identity)]:
            with self.subTest(kind=kind):
                requests = []
                def reply(handler, request):
                    requests.append(request.strip())
                    handler.wfile.write(b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n' + json.dumps({'Id': self.identity}).encode())
                with daemon(reply):
                    self.assertEqual(json.loads(host.docker_inspect(kind, self.identity)), [{'Id': self.identity}])
                self.assertEqual(requests, ['GET /v1.47' + path + ' HTTP/1.1'])

    def test_rejects_failed_malformed_truncated_and_oversized_responses(self):
        for response in [
            b'HTTP/1.1 500 Error\r\nContent-Length: 2\r\n\r\n{}',
            b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{',
            b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n[]',
            b'HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{}',
            b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n' + b' ' * (2 * 1024 * 1024 + 1),
            b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{"Id":"\xff"}',
        ]:
            with self.subTest(prefix=response[:80]):
                with daemon(lambda handler, request: handler.wfile.write(response)):
                    with self.assertRaises((ValueError, OSError, host.http.client.HTTPException)):
                        host.docker_inspect('container', self.identity)

    def test_deadline_is_not_restarted_by_trickling_body_bytes(self):
        self.trickling_deadline(b'')

    def test_deadline_retains_socket_after_connection_close_response(self):
        self.trickling_deadline(b'Connection: close\r\n')

    def trickling_deadline(self, headers):
        stopped = threading.Event()
        def reply(handler, request):
            try:
                handler.wfile.write(b'HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n' + headers + b'\r\n')
                for _ in range(300):
                    handler.wfile.write(b' ')
                    time.sleep(0.01)
            finally:
                stopped.set()
        with daemon(reply):
            start = time.monotonic()
            with self.assertRaises((ValueError, OSError, host.http.client.HTTPException)):
                host.docker_inspect('container', self.identity)
            self.assertLess(time.monotonic() - start, 2)
            self.assertTrue(stopped.wait(timeout=2))

    def test_rejects_paths_and_mutation_kinds_before_connect(self):
        for kind, identity in [('container', '../info'), ('start', self.identity), ('network', 'name')]:
            with self.subTest(kind=kind), patch.object(host.socket, 'socket') as connect:
                with self.assertRaises(ValueError):
                    host.docker_inspect(kind, identity)
                connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
