import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createServer as tcpServer, type Server as TcpServer } from 'node:net';
import { createServer as tlsServer } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ListeningProcess } from './listening-ports.js';
import {
  WEB_LISTENER_PROBE_SCRIPT,
  WebListenerClassifier,
  WEB_PROBE_BATCH_SIZE,
} from './web-listener-probe.js';

const execute = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
let key: Buffer;
let cert: Buffer;
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-probe-cert-'));
  try {
    await execute('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
    ]);
    key = await readFile(join(root, 'key.pem'));
    cert = await readFile(join(root, 'cert.pem'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function listen(server: Server | TcpServer): Promise<number> {
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket: import('node:net').Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as { port: number }).port;
}
async function probe(port: number) {
  const result = await execute(
    process.execPath,
    ['-e', WEB_LISTENER_PROBE_SCRIPT, JSON.stringify([{ host: '127.0.0.1', port }])],
    { timeout: 3_000 },
  );
  return JSON.parse(result.stdout) as unknown[];
}

it.each([200, 301, 401, 404, 405, 500])(
  'recognizes HTTP status %s with a credential-free HEAD and no redirect follow',
  async (status) => {
    let requests = 0;
    const server = httpServer((req, res) => {
      requests++;
      expect(req.method).toBe('HEAD');
      expect(req.url).toBe('/');
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      res.writeHead(status, { location: 'http://127.0.0.1:1/never-follow' });
      res.end();
    });
    expect(await probe(await listen(server))).toEqual([{ protocol: 'http' }]);
    expect(requests).toBe(1);
  },
);

it('recognizes self-signed HTTPS and returns its exact certificate fingerprint', async () => {
  const server = httpsServer({ key, cert }, (_req, res) => res.end());
  expect(await probe(await listen(server))).toEqual([
    { protocol: 'https', certificateFingerprint: new X509Certificate(cert).fingerprint256 },
  ]);
});

it.each(['silent', 'malformed', 'tcp-banner', 'tls'])(
  'does not classify %s as a web service and closes probe connections',
  async (kind) => {
    const server =
      kind === 'tls'
        ? tlsServer({ key, cert }, (socket) => socket.end('not HTTP'))
        : tcpServer((socket) => {
            if (kind === 'malformed') socket.end('HTTP/1.1 banana\r\n\r\n');
            if (kind === 'tcp-banner') socket.end('SSH-2.0-example\r\n');
          });
    expect(await probe(await listen(server))).toEqual([null]);
  },
);

const listener = (overrides: Partial<ListeningProcess> = {}): ListeningProcess => ({
  port: 5173,
  pid: 42,
  cwd: '/work',
  command: 'unknown-daemon',
  bind: 'any',
  socketInode: '12',
  sandboxGeneration: 'generation-a',
  listenerAddress: '127.0.0.1',
  ...overrides,
});
it('retries a starting service and caches only a bounded lifetime', async () => {
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const classifier = new WebListenerClassifier();
  const probe = vi
    .fn()
    .mockResolvedValueOnce([null])
    .mockResolvedValue([{ protocol: 'http' }]);
  expect((await classifier.classify('p', [listener()], probe))[0]?.webProtocol).toBeUndefined();
  now = 1_000;
  await classifier.classify('p', [listener()], probe);
  expect(probe).toHaveBeenCalledTimes(1);
  now = 2_001;
  expect((await classifier.classify('p', [listener()], probe))[0]?.webProtocol).toBe('http');
  now = 12_002;
  await classifier.classify('p', [listener()], probe);
  expect(probe).toHaveBeenCalledTimes(3);
});
it('does not reuse a verdict across socket reuse or container generation changes', async () => {
  const classifier = new WebListenerClassifier();
  const probe = vi
    .fn()
    .mockResolvedValueOnce([{ protocol: 'http' }])
    .mockResolvedValue([null]);
  await classifier.classify('p', [listener()], probe);
  for (const changed of [
    { socketInode: '13' },
    { socketInode: '13', sandboxGeneration: 'generation-b' },
  ]) {
    expect(
      (await classifier.classify('p', [listener(changed)], probe))[0]?.webProtocol,
    ).toBeUndefined();
  }
  expect(probe).toHaveBeenCalledTimes(3);
});
it('joins concurrent probes, bounds each batch and eventually checks every socket', async () => {
  const classifier = new WebListenerClassifier();
  const processes = Array.from({ length: WEB_PROBE_BATCH_SIZE * 2 + 1 }, (_, i) =>
    listener({ port: 3000 + i }),
  );
  const probe = vi.fn(async (targets: readonly unknown[]) =>
    targets.map(() => ({ protocol: 'http' })),
  );
  await Promise.all([
    classifier.classify('p', processes, probe),
    classifier.classify('p', processes, probe),
  ]);
  expect(probe).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 4; i++) await classifier.classify('p', processes, probe);
  expect(probe.mock.calls.every(([targets]) => targets.length <= WEB_PROBE_BATCH_SIZE)).toBe(true);
  const ports = new Set(
    probe.mock.calls.flatMap(([targets]) => targets.map((t) => (t as { port: number }).port)),
  );
  expect(ports.size).toBe(processes.length);
});
it('fails closed on probe failure and malformed protocol metadata without losing raw listeners', async () => {
  const classifier = new WebListenerClassifier();
  const processes = [listener(), listener({ port: 5174 })];
  const result = await classifier.classify('p', processes, async () => [
    { protocol: 'https', certificateFingerprint: 'bad' },
  ]);
  expect(result).toHaveLength(2);
  expect(result.every((p) => p.webProtocol === undefined)).toBe(true);
  const failed = await classifier.classify(
    'p',
    processes,
    async () => {
      throw new Error('exec failed');
    },
    true,
  );
  expect(failed.every((p) => p.webProtocol === undefined)).toBe(true);
});
