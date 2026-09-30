"""Regression test for a request that half-closes before its response."""

import asyncio
import unittest

from scripts.ios_pinned_tls_relay import relay


class RelayTest(unittest.IsolatedAsyncioTestCase):
    async def test_response_survives_request_half_close(self):
        async def backend(reader, writer):
            self.assertEqual(await reader.read(), b"request")
            writer.write(b"response")
            await writer.drain()
            writer.close()

        backend_server = await asyncio.start_server(backend, "127.0.0.1", 0)
        backend_port = backend_server.sockets[0].getsockname()[1]
        relay_server = await asyncio.start_server(
            lambda reader, writer: relay(reader, writer, upstream_port=backend_port),
            "127.0.0.1",
            0,
        )
        relay_port = relay_server.sockets[0].getsockname()[1]
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", relay_port)
            writer.write(b"request")
            writer.write_eof()
            self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"response")
            writer.close()
            await writer.wait_closed()
        finally:
            relay_server.close()
            backend_server.close()
            await relay_server.wait_closed()
            await backend_server.wait_closed()
