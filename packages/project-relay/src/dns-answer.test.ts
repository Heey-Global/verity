import { createSocket } from 'node:dgram';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import {
  answerDnsQuery,
  brokerNameLookup,
  buildDnsResponse,
  parseDnsQuery,
  type DirectNameAnswer,
} from './dns-answer.js';
import { startDnsForwarder } from './dns.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function query(name: string, type = 1, id = 0x1234, extra?: (buffer: Buffer) => void): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels = name
    .split('.')
    .map((label) => Buffer.concat([Buffer.of(label.length), Buffer.from(label)]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  const message = Buffer.concat([header, ...labels, Buffer.of(0), tail]);
  extra?.(message);
  return message;
}

function decode(reply: Buffer) {
  const rcode = reply.readUInt16BE(2) & 0x0f;
  const count = reply.readUInt16BE(6);
  let offset = 12;
  // A FORMERR reply carries only the header.
  if (reply.length > 12) {
    while (reply[offset] !== 0) offset += reply[offset]! + 1;
    offset += 5;
  }
  const addresses: string[] = [];
  let ttl = 0;
  for (let index = 0; index < count; index += 1) {
    expect(reply.readUInt16BE(offset)).toBe(0xc00c);
    ttl = reply.readUInt32BE(offset + 6);
    const length = reply.readUInt16BE(offset + 10);
    const data = reply.subarray(offset + 12, offset + 12 + length);
    addresses.push(
      length === 4
        ? [...data].join('.')
        : (data.toString('hex').match(/.{4}/gu) ?? [])
            .map((group) => group.replace(/^0+(?=.)/u, ''))
            .join(':'),
    );
    offset += 12 + length;
  }
  return { id: reply.readUInt16BE(0), rcode, addresses, ttl, flags: reply.readUInt16BE(2) };
}

it('parses exactly one canonical IN question and rejects everything else', () => {
  expect(parseDnsQuery(query('Downloads.Example.COM'))).toMatchObject({
    id: 0x1234,
    name: 'downloads.example.com',
    type: 1,
    recursionDesired: true,
  });
  const invalid = [
    Buffer.alloc(11),
    query('example.com', 1, 1, (m) => m.writeUInt16BE(0x8100, 2)), // a response
    query('example.com', 1, 1, (m) => m.writeUInt16BE(0x2900, 2)), // opcode update
    query('example.com', 1, 1, (m) => m.writeUInt16BE(2, 4)), // two questions
    query('example.com', 1, 1, (m) => m.writeUInt16BE(1, 6)), // answers in a query
    query('example.com', 1, 1, (m) => m.writeUInt16BE(1, 8)), // authority records
    query('example.com', 1, 1, (m) => m.writeUInt16BE(2, 10)), // more than EDNS
    query('example.com', 1, 1, (m) => m.writeUInt16BE(3, m.length - 2)), // class CH
    query('ex_ample.com'),
    query('-bad.example.com'),
    Buffer.concat([query('example.com').subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]),
    query('example.com').subarray(0, 20),
  ];
  for (const message of invalid) expect(parseDnsQuery(message)).toBeUndefined();
});

it('answers only from the authority: refused, empty, addresses or failure', async () => {
  const lookup = vi.fn(async (name: string, type: 'A' | 'AAAA'): Promise<DirectNameAnswer> =>
    name !== 'downloads.example.com'
      ? { granted: false, addresses: [], ttlSeconds: 1 }
      : type === 'A'
        ? { granted: true, addresses: ['8.8.8.8', '8.8.4.4'], ttlSeconds: 3 }
        : { granted: true, addresses: ['2001:4860:4860::8888'], ttlSeconds: 3 },
  );
  const a = decode((await answerDnsQuery(query('downloads.example.com'), lookup))!);
  expect(a).toMatchObject({ id: 0x1234, rcode: 0, addresses: ['8.8.8.8', '8.8.4.4'], ttl: 3 });
  expect(a.flags & 0x8000).toBeTruthy();
  expect(a.flags & 0x0400).toBe(0); // never authoritative
  const aaaa = decode((await answerDnsQuery(query('downloads.example.com', 28), lookup))!);
  expect(aaaa.addresses).toEqual(['2001:4860:4860:0:0:0:0:8888']);
  expect(decode((await answerDnsQuery(query('other.example.com'), lookup))!).rcode).toBe(5);
  // Other types of a granted name are empty, never forwarded.
  expect(decode((await answerDnsQuery(query('downloads.example.com', 65), lookup))!)).toMatchObject(
    { rcode: 0, addresses: [] },
  );
  lookup.mockRejectedValueOnce(new Error('host unavailable'));
  expect(decode((await answerDnsQuery(query('downloads.example.com'), lookup))!).rcode).toBe(2);
  const malformed = query('example.com', 1, 0x4321, (m) => m.writeUInt16BE(2, 4));
  expect(decode((await answerDnsQuery(malformed, lookup))!)).toMatchObject({
    id: 0x4321,
    rcode: 1,
  });
  expect(await answerDnsQuery(Buffer.alloc(8), lookup)).toBeUndefined();
});

it('keeps answers for the longest names within a classic UDP reply', async () => {
  const long = Array.from({ length: 4 }, () => 'a'.repeat(61)).join('.') + '.example.com';
  const many = async (_name: string, type: 'A' | 'AAAA'): Promise<DirectNameAnswer> => ({
    granted: true,
    addresses: Array.from({ length: 32 }, (_, i) =>
      type === 'A' ? `8.8.8.${i + 1}` : `2001:db8::${i + 1}`,
    ),
    ttlSeconds: 1,
  });
  for (const type of [1, 28]) {
    const reply = (await answerDnsQuery(query(long.slice(-253), type), many))!;
    expect(reply.length).toBeLessThanOrEqual(512);
    expect(decode(reply).addresses.length).toBeGreaterThan(0);
  }
  // A response arriving at the answerer is dropped, not answered.
  const response = query('example.com', 1, 9, (m) => m.writeUInt16BE(0x8180, 2));
  expect(await answerDnsQuery(response, many)).toBeUndefined();
});
it('keeps answers within a classic UDP reply', () => {
  const parsed = parseDnsQuery(query('downloads.example.com', 28))!;
  const reply = buildDnsResponse(
    parsed,
    0,
    Array.from({ length: 8 }, (_, i) => `2001:db8::${i + 1}`),
  );
  expect(reply.length).toBeLessThanOrEqual(512);
});

it('answers UDP and TCP locally in controlled mode without any upstream', async () => {
  const upstream = createSocket('udp4');
  const contacted = vi.fn();
  upstream.on('message', contacted);
  await new Promise<void>((resolve) => upstream.bind(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => upstream.close(() => resolve())));
  const lookup = async (): Promise<DirectNameAnswer> => ({
    granted: true,
    addresses: ['8.8.8.8'],
    ttlSeconds: 2,
  });
  const forwarder = await startDnsForwarder({
    host: '127.0.0.1',
    port: 0,
    upstream: { host: '127.0.0.1', port: upstream.address().port },
    answer: (message) => answerDnsQuery(message, lookup),
  });
  cleanups.push(() => forwarder.close());
  const client = createSocket('udp4');
  cleanups.push(() => new Promise((resolve) => client.close(() => resolve())));
  const udpReply = await new Promise<Buffer>((resolve) => {
    client.once('message', resolve);
    client.send(query('downloads.example.com'), forwarder.udpPort, '127.0.0.1');
  });
  expect(decode(udpReply).addresses).toEqual(['8.8.8.8']);
  const tcpReply = await new Promise<Buffer>((resolve, reject) => {
    const socket = createConnection(forwarder.tcpPort, '127.0.0.1');
    const message = query('downloads.example.com', 1, 7);
    const frame = Buffer.alloc(2);
    frame.writeUInt16BE(message.length);
    socket.on('error', reject);
    socket.once('data', (data: Buffer) => {
      socket.destroy();
      resolve(data.subarray(2, 2 + data.readUInt16BE(0)));
    });
    // Split the frame to exercise reassembly.
    socket.write(Buffer.concat([frame, message.subarray(0, 5)]));
    setTimeout(() => socket.write(message.subarray(5)), 10);
  });
  expect(decode(tcpReply)).toMatchObject({ id: 7, addresses: ['8.8.8.8'] });
  expect(contacted).not.toHaveBeenCalled();
});

it('asks the broker socket and rejects malformed or out-of-family answers', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'dns-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'b.sock');
  let reply: unknown = { granted: true, addresses: ['8.8.8.8'], ttlSeconds: 2 };
  let status = 200;
  const seen: unknown[] = [];
  const server: HttpServer = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const lookup = brokerNameLookup(socketPath, 1000);
  expect(await lookup('downloads.example.com', 'A')).toEqual(reply);
  expect(seen[0]).toEqual({
    method: 'POST',
    url: '/internal/dns',
    body: { name: 'downloads.example.com', type: 'A' },
  });
  for (const bad of [
    { granted: true, addresses: ['2001:db8::1'], ttlSeconds: 2 },
    { granted: 'yes', addresses: [], ttlSeconds: 2 },
    { granted: true, addresses: ['8.8.8.8'], ttlSeconds: 60 },
    { granted: true, addresses: Array<string>(33).fill('8.8.8.8'), ttlSeconds: 2 },
  ]) {
    reply = bad;
    await expect(lookup('downloads.example.com', 'A')).rejects.toThrow();
  }
  reply = { error: 'unauthorized' };
  status = 401;
  await expect(lookup('downloads.example.com', 'A')).rejects.toThrow();
});

it('stops answering a controlled TCP client that never reads its replies', async () => {
  let lookups = 0;
  const addresses = Array.from({ length: 28 }, (_, i) => `8.8.4.${i + 1}`);
  const lookup = async (): Promise<DirectNameAnswer> => {
    lookups += 1;
    return { granted: true, addresses, ttlSeconds: 2 };
  };
  const forwarder = await startDnsForwarder({
    host: '127.0.0.1',
    port: 0,
    answer: (message) => answerDnsQuery(message, lookup),
  });
  cleanups.push(() => forwarder.close());
  const socket = createConnection(forwarder.tcpPort, '127.0.0.1');
  cleanups.push(async () => {
    socket.destroy();
  });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  // Never read: replies can only accumulate in the relay's own write buffer.
  socket.pause();
  const message = query('downloads.example.com', 1, 9);
  const frame = Buffer.alloc(2);
  frame.writeUInt16BE(message.length);
  // Batches stay below the bounded input buffer; a stall means backpressure held.
  const batch = Buffer.concat(Array.from({ length: 64 }, () => Buffer.concat([frame, message])));
  let stalled = false;
  for (let round = 0; round < 1_000 && !stalled; round++) {
    const target = lookups + 64;
    socket.write(batch);
    const deadline = Date.now() + 300;
    while (lookups < target && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2));
    stalled = lookups < target;
  }
  expect(stalled).toBe(true);
  // Many replies flowed first: the stall is the full write buffer, not a slow runner.
  expect(lookups).toBeGreaterThan(1_000);
  expect(lookups).toBeLessThan(64_000);
}, 60_000);
