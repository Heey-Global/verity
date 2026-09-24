import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createConnection, createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDnsForwarder, type DnsForwarder } from './dns.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A DNS query for `name` (A record), enough for a byte-relaying forwarder. */
function query(id: number, name = 'registry.npmjs.org'): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels = name
    .split('.')
    .map((label) => Buffer.concat([Buffer.of(label.length), Buffer.from(label)]));
  return Buffer.concat([header, ...labels, Buffer.of(0), Buffer.from([0, 1, 0, 1])]);
}

/** Stands in for Docker's embedded resolver: answers every query with its id and a marker. */
async function fakeUpstream(options: { silent?: boolean } = {}) {
  const received: Buffer[] = [];
  const udp = createSocket('udp4');
  udp.on('message', (message, from) => {
    received.push(message);
    if (options.silent) return;
    udp.send(
      Buffer.concat([message.subarray(0, 2), Buffer.from('answer')]),
      from.port,
      from.address,
    );
  });
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const port = udp.address().port;
  const tcp: Server = createServer((socket) => {
    socket.once('data', (framed) => {
      const reply = Buffer.concat([framed.subarray(2, 4), Buffer.from('tcp-answer')]);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(reply.length);
      socket.end(Buffer.concat([length, reply]));
    });
  });
  await new Promise<void>((resolve) => tcp.listen(port, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve) => udp.close(() => resolve()));
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  });
  return { port, received };
}

async function forwarder(upstreamPort: number, limits = {}): Promise<DnsForwarder> {
  const started = await startDnsForwarder({
    host: '127.0.0.1',
    port: 0,
    upstream: { host: '127.0.0.1', port: upstreamPort },
    limits: { timeoutMs: 500, ...limits },
  });
  cleanups.push(() => started.close());
  return started;
}

async function client(): Promise<UdpSocket> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
  return socket;
}

function answer(socket: UdpSocket, withinMs = 1_000): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), withinMs);
    socket.once('message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

describe('the relay DNS forwarder', () => {
  it('retries when an automatic UDP port is already occupied by TCP', async () => {
    const upstream = await fakeUpstream();
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const address = occupied.address();
    if (typeof address !== 'object' || address === null) throw new Error('missing TCP address');

    const probe = createSocket('udp4');
    const udpPrototype = Object.getPrototypeOf(probe) as UdpSocket;
    probe.close();
    // Preserve the real method before spying so the forced first allocation still
    // creates an actual socket; binding it here would pin `this` to the probe.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalBind = udpPrototype.bind as unknown as (
      this: UdpSocket,
      port: number,
      address: string,
      callback?: () => void,
    ) => UdpSocket;
    vi.spyOn(udpPrototype, 'bind').mockImplementationOnce(function (
      this: UdpSocket,
      ...args: Parameters<UdpSocket['bind']>
    ) {
      const callback = args.find((arg): arg is () => void => typeof arg === 'function');
      return originalBind.call(this, address.port, '127.0.0.1', callback);
    });

    const dns = await forwarder(upstream.port);
    expect(dns.udpPort).toBe(dns.tcpPort);
    expect(dns.udpPort).not.toBe(address.port);
  });

  it('answers a Sandbox query over UDP from the upstream resolver', async () => {
    const upstream = await fakeUpstream();
    const dns = await forwarder(upstream.port);
    const sandbox = await client();
    const reply = answer(sandbox);
    sandbox.send(query(0x1234), dns.udpPort, '127.0.0.1');
    const message = await reply;
    expect(message?.readUInt16BE(0)).toBe(0x1234);
    expect(message?.subarray(2).toString()).toBe('answer');
    expect(upstream.received).toHaveLength(1);
  });

  // A truncated UDP answer makes the resolver retry over TCP on the same port; without it
  // large answers (many A records, DNSSEC) fail inside the Sandbox only.
  it('relays DNS over TCP on the same port', async () => {
    const upstream = await fakeUpstream();
    const dns = await forwarder(upstream.port);
    expect(dns.tcpPort).toBe(dns.udpPort);
    const framed = Buffer.concat([Buffer.from([0, 0]), query(0x4321)]);
    framed.writeUInt16BE(framed.length - 2);
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const socket = createConnection(dns.tcpPort, '127.0.0.1', () => socket.write(framed));
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.once('end', () => resolve(Buffer.concat(chunks)));
      socket.once('error', reject);
    });
    expect(reply.readUInt16BE(2)).toBe(0x4321);
    expect(reply.subarray(4).toString()).toBe('tcp-answer');
  });

  it('ignores datagrams that cannot be DNS messages', async () => {
    const upstream = await fakeUpstream();
    const dns = await forwarder(upstream.port);
    const sandbox = await client();
    sandbox.send(Buffer.alloc(4), dns.udpPort, '127.0.0.1');
    sandbox.send(Buffer.alloc(4097), dns.udpPort, '127.0.0.1');
    expect(await answer(sandbox, 200)).toBeUndefined();
    expect(upstream.received).toHaveLength(0);
  });

  // One Sandbox must not be able to make the relay hold unbounded sockets open.
  it('drops queries past its in-flight budget instead of queueing them', async () => {
    const upstream = await fakeUpstream({ silent: true });
    const dns = await forwarder(upstream.port, { maxInFlightUdp: 2 });
    const sandbox = await client();
    for (let id = 1; id <= 5; id += 1) sandbox.send(query(id), dns.udpPort, '127.0.0.1');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(upstream.received).toHaveLength(2);
    // Once the unanswered ones time out, the budget is free again.
    await new Promise((resolve) => setTimeout(resolve, 600));
    sandbox.send(query(6), dns.udpPort, '127.0.0.1');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(upstream.received).toHaveLength(3);
  });
});
