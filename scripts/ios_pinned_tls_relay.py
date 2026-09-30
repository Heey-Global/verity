"""Byte-only TCP relay used by the iOS certificate-pinning smoke test."""

import asyncio
from contextlib import suppress


async def relay(reader, writer, upstream_host="127.0.0.1", upstream_port=18444):
    upstream = None
    tasks = []

    async def pump(source, target):
        while data := await source.read(65536):
            target.write(data)
            await target.drain()
        # A peer can half-close after sending its request. Forward that EOF,
        # then leave the opposite pump alive to deliver the response.
        if target.can_write_eof():
            with suppress(ConnectionError, OSError):
                target.write_eof()
                await target.drain()

    try:
        remote_reader, upstream = await asyncio.wait_for(
            asyncio.open_connection(upstream_host, upstream_port), timeout=5
        )
        tasks = [
            asyncio.create_task(pump(reader, upstream)),
            asyncio.create_task(pump(remote_reader, writer)),
        ]
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=30)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        if upstream is not None:
            upstream.close()
