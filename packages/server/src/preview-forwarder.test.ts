import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createServer } from 'node:https';
import { afterEach, expect, it } from 'vitest';
import { PREVIEW_FORWARDER_SCRIPT } from './preview-forwarder.js';

const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'preview-tls-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
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
  const cert = await readFile(join(root, 'cert.pem'));
  const fingerprint = new X509Certificate(cert).fingerprint256;
  let requests = 0;
  const server = createServer({ key: await readFile(join(root, 'key.pem')), cert }, (_req, res) => {
    requests++;
    res.end('pinned target');
  });
  server.on('upgrade', (_req, socket) => {
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nupgraded target',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const port = (server.address() as { port: number }).port;
  const pids = new Set<number>();
  cleanups.push(async () => {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        /* The helper may already have exited. */
      }
    }
  });
  const start = async (pin = fingerprint, protocol = 'https') => {
    const { stdout } = await execute(
      process.execPath,
      ['-e', PREVIEW_FORWARDER_SCRIPT, String(port), '127.0.0.1', protocol, pin],
      { env: { ...process.env, VERITY_PREVIEW_FORWARDER_STATE_DIR: root } },
    );
    const state = JSON.parse(await readFile(join(root, `${port}.json`), 'utf8')) as { pid: number };
    pids.add(state.pid);
    return Number(stdout.trim());
  };
  return { start, requests: () => requests };
}

function request(port: number, upgrade = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port });
    let response = '';
    client.setTimeout(3000, () => client.destroy(new Error('relay timed out')));
    client.on('connect', () =>
      client.write(
        upgrade
          ? 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
          : 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      ),
    );
    client.on('data', (chunk) => {
      response += chunk.toString();
    });
    client.on('close', () => resolve(response));
    client.on('error', reject);
  });
}

it('relays self-signed HTTPS only after the locally observed certificate matches', async () => {
  const target = await fixture();
  const relay = await target.start();
  expect(await request(relay)).toContain('pinned target');
  expect(target.requests()).toBe(1);
  expect(await target.start()).toBe(relay);
});

it('sends no HTTP request to a TLS peer whose certificate does not match', async () => {
  const target = await fixture();
  const relay = await target.start('00'.repeat(32));
  expect(await request(relay)).toBe('');
  expect(target.requests()).toBe(0);
});

it('replaces a relay when its pinned certificate or transport changes', async () => {
  const target = await fixture();
  const wrongPin = await target.start('00'.repeat(32));
  const correctedPin = await target.start();
  expect(correctedPin).not.toBe(wrongPin);
  expect(await request(correctedPin)).toContain('pinned target');
  expect(await target.start('', 'http')).not.toBe(correctedPin);
});

it('preserves HTTP upgrades through the pinned TLS transport', async () => {
  const target = await fixture();
  const relay = await target.start();
  const response = await request(relay, true);
  expect(response).toContain('101 Switching Protocols');
  expect(response).toContain('upgraded target');
});
