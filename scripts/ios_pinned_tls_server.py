"""TLS endpoint for the native pinning smoke fixture."""

import http.server
import socketserver


class SmokeServer(http.server.ThreadingHTTPServer):
    def __init__(self, address, handler, context):
        self.tls_context = context
        super().__init__(address, handler)

    def server_bind(self):
        # Fixture startup must not depend on runner reverse DNS.
        socketserver.TCPServer.server_bind(self)
        self.server_name = self.server_address[0]
        self.server_port = self.server_address[1]

    def get_request(self):
        connection, address = self.socket.accept()
        try:
            # The accept loop must remain available while a peer stalls TLS.
            return self.tls_context.wrap_socket(
                connection, server_side=True, do_handshake_on_connect=False
            ), address
        except Exception:
            connection.close()
            raise

    def process_request_thread(self, request, client_address):
        request.settimeout(5)
        try:
            request.do_handshake()
        except (OSError, TimeoutError):
            self.shutdown_request(request)
            return
        super().process_request_thread(request, client_address)
