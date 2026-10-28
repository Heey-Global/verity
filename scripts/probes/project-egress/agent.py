"""Synthetic receiver and untrusted project probe. No public endpoint is contacted."""

import asyncio
import datetime
import ipaddress
import json
import os
import socket
import ssl
import struct
import sys
from pathlib import Path

TIMEOUT = 1.0


def emit(marker, transport):
    print(json.dumps({"marker": marker, "transport": transport}), flush=True)


def dns_query(name, qtype=1):
    labels = b"".join(bytes([len(part)]) + part.encode() for part in name.split("."))
    return (
        struct.pack("!6H", 123, 0x100, 1, 0, 0, 0)
        + labels
        + b"\0"
        + struct.pack("!HH", qtype, 1)
    )


def dns_response(packet, addresses):
    offset, labels = 12, []
    while packet[offset]:
        size = packet[offset]
        labels.append(packet[offset + 1 : offset + 1 + size].decode())
        offset += size + 1
    offset += 1
    qtype = struct.unpack("!H", packet[offset : offset + 2])[0]
    name = ".".join(labels)
    emit(labels[0], "dns")
    # There is no recursive resolver or arbitrary upstream in this fixture.
    if name.endswith(".allowed.test") or name.endswith(".switch.test"):
        target = addresses[1] if name.endswith(".switch.test") else addresses[0]
        address = target[1] if qtype == 28 else target[0]
        payload = ipaddress.ip_address(address).packed
        answer = b"\xc0\x0c" + struct.pack("!HHIH", qtype, 1, 0, len(payload)) + payload
        return (
            packet[:2]
            + struct.pack("!5H", 0x8180, 1, 1, 0, 0)
            + packet[12 : offset + 4]
            + answer
        )
    return packet[:2] + struct.pack("!5H", 0x8183, 1, 0, 0, 0) + packet[12 : offset + 4]


class DatagramReceiver(asyncio.DatagramProtocol):
    def __init__(self, dns=None):
        self.dns = dns

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, peer):
        if self.dns:
            reply = dns_response(data, self.dns)
        else:
            emit(data.decode().strip(), "udp")
            reply = data
        self.transport.sendto(reply, peer)


async def receive_stream(reader, writer, kind="tcp", dns=None):
    try:
        while True:
            if dns:
                size = struct.unpack("!H", await reader.readexactly(2))[0]
                packet = dns_response(await reader.readexactly(size), dns)
                writer.write(struct.pack("!H", len(packet)) + packet)
            else:
                data = await reader.readline()
                if not data:
                    break
                line = data.decode().strip()
                if line.startswith("GET "):
                    path = line.split(" ")[1]
                    marker = path.rsplit("/", 1)[-1]
                    emit(marker, "http")
                    # Redirect is deliberately to the second, non-allowed destination.
                    target = os.environ["REDIRECT_TARGET"]
                    writer.write(
                        f"HTTP/1.1 302 Found\r\nLocation: http://{target}:8080/{marker}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode()
                    )
                    await writer.drain()
                    break
                emit(line, kind)
                writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()


def certificate():
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "synthetic.invalid")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    Path("/tmp/key.pem").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    Path("/tmp/cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))


async def receiver():
    from aioquic.asyncio import serve
    from aioquic.quic.configuration import QuicConfiguration

    addresses = json.loads(os.environ["DNS_ADDRESSES"])
    loop = asyncio.get_running_loop()
    servers, datagrams = [], []
    for host, family in (("0.0.0.0", socket.AF_INET), ("::", socket.AF_INET6)):
        servers.append(
            await asyncio.start_server(receive_stream, host, 8080, family=family)
        )
        servers.append(
            await asyncio.start_server(
                lambda r, w: receive_stream(r, w, dns=addresses),
                host,
                53,
                family=family,
            )
        )
        for port, dns in ((8080, None), (53, addresses)):
            sock = socket.socket(family, socket.SOCK_DGRAM)
            if family == socket.AF_INET6:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            sock.bind((host, port))
            sock.setblocking(False)
            datagrams.append(
                await loop.create_datagram_endpoint(
                    lambda dns=dns: DatagramReceiver(dns), sock=sock
                )
            )
    certificate()
    config = QuicConfiguration(is_client=False, alpn_protocols=["egress-probe"])
    config.load_cert_chain("/tmp/cert.pem", "/tmp/key.pem")
    quic = await serve(
        "::",
        4433,
        configuration=config,
        stream_handler=lambda r, w: asyncio.create_task(receive_stream(r, w, "quic")),
    )
    print(json.dumps({"ready": True}), flush=True)
    try:
        await asyncio.Future()
    finally:
        quic.close()
        for server in servers:
            server.close()
        for transport, _ in datagrams:
            transport.close()


async def send(request):
    host, kind, marker = request["host"], request["kind"], request["marker"]
    port = request.get("port", 8080)
    if kind in ("udp", "dns", "resolve"):
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_DGRAM)
        sock.setblocking(False)
        try:
            loop = asyncio.get_running_loop()
            payload = marker.encode()
            if kind in ("dns", "resolve"):
                payload = dns_query(
                    marker + request.get("suffix", ".allowed.test"),
                    28 if request.get("ipv6") else 1,
                )
                port = 53
            await loop.sock_sendto(sock, payload, (host, port))
            data, _ = await asyncio.wait_for(loop.sock_recvfrom(sock, 4096), TIMEOUT)
            if kind == "resolve":
                size = 16 if request.get("ipv6") else 4
                address = str(ipaddress.ip_address(data[-size:]))
                return await send({**request, "host": address, "kind": "tcp"})
            return {"received": True}
        finally:
            sock.close()
    if kind == "quic":
        from aioquic.asyncio import connect
        from aioquic.quic.configuration import QuicConfiguration

        config = QuicConfiguration(
            is_client=True, alpn_protocols=["egress-probe"], verify_mode=ssl.CERT_NONE
        )
        async with connect(host, 4433, configuration=config) as connection:
            reader, writer = await connection.create_stream()
            writer.write((marker + "\n").encode())
            await writer.drain()
            await reader.readline()
            writer.close()
        return {"received": True}
    reader, writer = await asyncio.open_connection(
        host, 53 if kind == "dns-tcp" else port
    )
    try:
        if kind == "dns-tcp":
            payload = dns_query(marker + ".allowed.test")
            writer.write(struct.pack("!H", len(payload)) + payload)
        elif kind == "redirect":
            writer.write(
                f"GET /{marker} HTTP/1.1\r\nHost: synthetic.invalid\r\nConnection: close\r\n\r\n".encode()
            )
        else:
            writer.write((marker + "\n").encode())
        await writer.drain()
        if kind == "redirect":
            headers = (await reader.read()).decode()
            from urllib.parse import urlsplit

            location = next(
                line[10:]
                for line in headers.split("\r\n")
                if line.startswith("Location: ")
            )
            target = urlsplit(location)
            return await send(
                {**request, "kind": "tcp", "host": target.hostname, "port": target.port}
            )
        await reader.read(4096)
        return {"received": True}
    finally:
        writer.close()


FLOWS = {}


async def operation(request):
    action = request.get("action", "send")
    if action == "flow-send-batch":
        return {
            "results": [
                await bounded({**item, "action": "flow-send"})
                for item in request["flows"]
            ]
        }
    if action == "flow-start":
        if request["kind"] == "tcp":
            FLOWS[request["id"]] = await asyncio.open_connection(request["host"], 8080)
        else:
            family = socket.AF_INET6 if ":" in request["host"] else socket.AF_INET
            sock = socket.socket(family, socket.SOCK_DGRAM)
            sock.connect((request["host"], 8080))
            FLOWS[request["id"]] = sock
        return {"opened": True}
    if action == "flow-send":
        flow = FLOWS[request["id"]]
        payload = (request["marker"] + "\n").encode()
        if isinstance(flow, tuple):
            flow[1].write(payload)
            await flow[1].drain()
        else:
            flow.send(payload)
        return {"sent": True}
    if action == "boundary":
        # Verify actual project-visible namespaces and mounts, not caller labels.
        paths = request["paths"]
        visible = [path for path in paths if Path(path).exists()]
        socket_access = False
        try:
            reader, writer = await asyncio.open_unix_connection(request["socket"])
            socket_access = bool(await reader.read(64))
            writer.close()
        except OSError:
            pass
        return {
            "visible": visible,
            "socket_access": socket_access,
            "pid1": Path("/proc/1/cmdline").read_bytes().decode().replace("\0", " "),
            "fds": [
                os.readlink(p) for p in Path("/proc/self/fd").iterdir() if p.exists()
            ],
        }
    return await send(request)


async def bounded(request):
    try:
        return await asyncio.wait_for(operation(request), TIMEOUT + 0.5)
    except (OSError, asyncio.TimeoutError, ValueError) as error:
        return {"error": type(error).__name__}


async def project():
    project_id = sys.argv[2]
    Path(f"/work/{project_id}-only").write_text("synthetic sentinel")

    async def sentinel(reader, writer):
        writer.write(b"synthetic socket\n")
        await writer.drain()
        writer.close()

    async def control(reader, writer):
        request = json.loads(await reader.readline())
        result = await bounded(request)
        writer.write((json.dumps(result) + "\n").encode())
        await writer.drain()
        writer.close()

    for name in ("control.sock", f"{project_id}.sock"):
        Path("/work/" + name).unlink(missing_ok=True)
    await asyncio.start_unix_server(control, "/work/control.sock")
    await asyncio.start_unix_server(sentinel, f"/work/{project_id}.sock")
    print(json.dumps({"ready": True}), flush=True)
    await asyncio.Future()


async def command():
    reader, writer = await asyncio.open_unix_connection("/work/control.sock")
    writer.write((sys.argv[2] + "\n").encode())
    await writer.drain()
    print((await reader.readline()).decode().strip())
    writer.close()


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "receiver":
        asyncio.run(receiver())
    elif mode == "project":
        asyncio.run(project())
    elif mode == "command":
        asyncio.run(command())
    elif mode == "send":
        print(json.dumps(asyncio.run(bounded(json.loads(sys.argv[2])))))
