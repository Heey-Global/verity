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

async function fixture(t, response, status = 200, closeCode) {
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
        if (response) peer.send(JSON.stringify(response(connect)));
        if (closeCode !== undefined) peer.close(closeCode);
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
    `#!/usr/bin/env node\nif (process.env.VERITY_REMOTE_TICKET !== "test_ticket") process.exit(2);\nif (process.env.VERITY_REMOTE_CORE_URL !== "https://core.example:8082/healthz") process.exit(3);\nconsole.log("attached"); console.log("Core HTTPS status: ${status}");\n`,
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
        VERITY_REMOTE_CORE_URL: 'https://core.example:8082/',
        VERITY_REMOTE_CORE_PIN: `sha256-${'a'.repeat(43)}`,
        VERITY_REMOTE_PROBE_BINARY: input.binary,
        ...(input.soakSeconds === undefined
          ? {}
          : { VERITY_REMOTE_PROBE_SOAK_SECONDS: input.soakSeconds }),
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

test('a soak longer than the watchdog allows is refused before admission', async (t) => {
  const input = await fixture(t, (connect) => ({
    type: 'connect.ready',
    requestId: connect.requestId,
    sessionId: 'test_session',
    ticket: 'test_ticket',
    expiresAt: Date.now() + 60_000,
    capability: 'remote-control-v1',
  }));
  const result = await runProbe({ ...input, soakSeconds: '601' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Invalid Remote Control staging probe inputs/u);
  // A spelling the native side would read as zero must not pass here either.
  const spelled = await runProbe({ ...input, soakSeconds: '1e2' });
  assert.notEqual(spelled.code, 0);
  assert.match(spelled.stderr, /Invalid Remote Control staging probe inputs/u);
  // Nor a soak too short to issue a single request, which would pass empty.
  const short = await runProbe({ ...input, soakSeconds: '10' });
  assert.notEqual(short.code, 0);
  assert.match(short.stderr, /Invalid Remote Control staging probe inputs/u);
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

for (const [label, closeCode, ready, success] of [
  ['normal completion after ready', 1000, true, true],
  ['normal close before ready', 1000, false, false],
  ['abnormal close after ready', 1011, true, false],
]) {
  test(label, async (t) => {
    const input = await fixture(
      t,
      ready
        ? (connect) => ({
            type: 'connect.ready',
            requestId: connect.requestId,
            sessionId: 'test_session',
            ticket: 'test_ticket',
            expiresAt: Date.now() + 60_000,
            capability: 'remote-control-v1',
          })
        : null,
      200,
      closeCode,
    );
    // Keep DATA attachment later than the server's admission completion.
    writeFileSync(
      input.binary,
      `#!/usr/bin/env node\nsetTimeout(() => { console.log('attached'); console.log('Core HTTPS status: 200'); }, 200);\n`,
      { mode: 0o755 },
    );
    const result = await runProbe(input);
    assert.equal(result.code === 0, success, result.stderr);
    if (!success) assert.match(result.stderr, /Admission closed before successful completion/u);
  });
}

for (const [stage, phase] of [
  ['native_start', 'unknown'],
  ['https_request', 'NO_AUTH_CHALLENGE'],
  ['https_request', 'AUTH_CHALLENGE_RECEIVED'],
  ['http_response', 'PIN_AND_CHAIN_TRUST_ACCEPTED'],
  ['soak_failed', 'NO_AUTH_CHALLENGE'],
]) {
  test(`failure receipt survives child exit at ${stage}/${phase} without raw output`, async (t) => {
    const input = await fixture(t, (connect) => ({
      type: 'connect.ready',
      requestId: connect.requestId,
      sessionId: 'test_session',
      ticket: 'test_ticket',
      expiresAt: Date.now() + 60_000,
      capability: 'remote-control-v1',
    }));
    writeFileSync(
      input.binary,
      `#!/usr/bin/env node
console.error('test_ticket secret-header https://private.invalid');
console.log('test_session secret-payload');
console.log('x'.repeat(10000));
console.log('probe-stage:secret-header');
console.log('probe-tls:secret-header');
console.log('probe-error:-1001');
console.log('probe-soak:2:3:9');
${stage === 'native_start' ? '' : `console.log('attached'); console.log('probe-stage:${stage}');`}
${phase === 'unknown' ? '' : `console.log('probe-tls:${phase}');`}
process.exitCode = 7;
`,
      { mode: 0o755 },
    );
    const result = await runProbe(input);
    assert.equal(result.code, 7);
    const line = result.stderr
      .split('\n')
      .find((line) => line.startsWith('Probe failure receipt: '));
    assert.ok(line, result.stderr);
    const receipt = JSON.parse(line.slice('Probe failure receipt: '.length));
    assert.equal(receipt.stage, stage);
    assert.equal(receipt.tlsPhase, phase);
    assert.match(receipt.sessionHash, /^[a-f0-9]{16}$/u);
    assert.equal(receipt.nativeExitCode, 7);
    assert.equal(receipt.nativeErrorCode, -1001);
    assert.deepEqual(receipt.soak, { worker: 2, ownRequests: 3, totalRequests: 9 });
    assert.ok(Date.parse(receipt.endedAt) >= Date.parse(receipt.startedAt));
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /test_ticket|test_session|secret-header|secret-payload|private\.invalid/u,
    );
    assert.ok(result.stderr.length < 1024);
  });
}

for (const sessionId of [123, ['test_session']]) {
  test(`non-string admission session ${typeof sessionId} fails safely`, async (t) => {
    const input = await fixture(t, (connect) => ({
      type: 'connect.ready',
      requestId: connect.requestId,
      sessionId,
      ticket: 'test_ticket',
      expiresAt: Date.now() + 60_000,
      capability: 'remote-control-v1',
    }));
    const result = await runProbe(input);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Probe failure receipt:/u);
    assert.match(result.stderr, /Invalid admission response/u);
    assert.doesNotMatch(result.stderr, /TypeError|test_ticket|test_session/u);
  });
}
