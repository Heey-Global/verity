import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const probe = fileURLToPath(new URL('./probe.mjs', import.meta.url));

async function fixture(t, response, status = 200) {
  const directory = mkdtempSync(join(tmpdir(), 'verity-staging-probe-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/remote-control') return socket.destroy();
    sockets.handleUpgrade(request, socket, head, (peer) => {
      peer.once('message', (raw) => {
        const connect = JSON.parse(raw.toString());
        assert.equal(connect.installationHandle, 'test_handle');
        peer.send(JSON.stringify(response(connect)));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    sockets.clients.forEach((peer) => peer.terminate());
    await new Promise((resolve) => server.close(resolve));
  });
  const binary = join(directory, 'fake-probe');
  writeFileSync(
    binary,
    `#!/usr/bin/env node\nif (process.env.VERITY_REMOTE_TICKET !== "test_ticket") process.exit(2);\nconsole.log("attached"); console.log("Core HTTPS status: ${status}");\n`,
    { mode: 0o755 },
  );
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { cert, binary, origin: `https://127.0.0.1:${address.port}` };
}

function runProbe(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe], {
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: input.cert,
        VERITY_REMOTE_UPLINK_ORIGIN: input.origin,
        VERITY_REMOTE_INSTALLATION_HANDLE: 'test_handle',
        VERITY_REMOTE_CORE_URL: 'https://core.example/',
        VERITY_REMOTE_CORE_PIN: `sha256-${'a'.repeat(43)}`,
        VERITY_REMOTE_PROBE_BINARY: input.binary,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('admission keeps its socket through attachment and runs the native GET', async (t) => {
  const input = await fixture(t, (connect) => ({
    type: 'connect.ready',
    requestId: connect.requestId,
    sessionId: 'test_session',
    ticket: 'test_ticket',
    expiresAt: Date.now() + 60_000,
    capability: 'remote-control-v1',
  }));
  const result = await runProbe(input);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Core HTTPS status: 200/u);
  assert.doesNotMatch(result.stdout, /test_ticket/u);
});

test('a ticket for a different request never reaches the native runner', async (t) => {
  const input = await fixture(t, () => ({
    type: 'connect.ready',
    requestId: 'wrong_request',
    sessionId: 'test_session',
    ticket: 'test_ticket',
    expiresAt: Date.now() + 60_000,
    capability: 'remote-control-v1',
  }));
  const result = await runProbe(input);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Invalid admission response/u);
});

test('an attached tunnel with an unsuccessful Core response fails the probe', async (t) => {
  const input = await fixture(
    t,
    (connect) => ({
      type: 'connect.ready',
      requestId: connect.requestId,
      sessionId: 'test_session',
      ticket: 'test_ticket',
      expiresAt: Date.now() + 60_000,
      capability: 'remote-control-v1',
    }),
    503,
  );
  const result = await runProbe(input);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /did not complete an attached Core HTTPS GET/u);
});
