"""An incomplete TLS client must not block the native smoke's other requests."""

import http.server
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

from scripts.ios_pinned_tls_server import SmokeServer


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *args):
        pass


class SmokeTLSAdmissionTest(unittest.TestCase):
    def test_idle_tls_peer_does_not_block_next_handshake(self):
        with tempfile.TemporaryDirectory() as directory:
            cert, key = (Path(directory) / name for name in ('cert.pem', 'key.pem'))
            subprocess.run([
                'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-keyout', str(key), '-out', str(cert), '-days', '1',
                '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            server = SmokeServer(('127.0.0.1', 0), Handler, context)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            idle = socket.create_connection(server.server_address, timeout=2)
            try:
                # Trust policy is covered by the Apple tests; this test isolates
                # accept-loop starvation by withholding the first ClientHello.
                client_context = ssl.create_default_context(cafile=str(cert))
                with socket.create_connection(server.server_address, timeout=2) as raw:
                    with client_context.wrap_socket(raw, server_hostname='localhost') as client:
                        client.sendall(b'GET / HTTP/1.0\r\nHost: localhost\r\n\r\n')
                        response = b''
                        while chunk := client.recv(4096):
                            response += chunk
                self.assertIn(b'200 OK', response)
                self.assertTrue(response.endswith(b'ok'))
            finally:
                idle.close()
                server.shutdown()
                server.server_close()
                serving.join(timeout=5)
                self.assertFalse(serving.is_alive())


if __name__ == '__main__':
    unittest.main()
