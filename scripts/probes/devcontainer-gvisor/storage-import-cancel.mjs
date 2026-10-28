// Disposable CI only: observe a partial real Engine import through a Unix-socket
// test transport. No TCP listener or production Docker endpoint is changed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { BuildStorage } from '../../../packages/server/dist/build-storage.js';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
const [workspace, source] = process.argv.slice(2);
assert(workspace && source?.startsWith('verity-host-builder-'));
const { AbortController } = globalThis;
const storage = new BuildStorage(process.env.PROBE_STORAGE_ROOT, process.env.PROBE_STORAGE_REPORT, {
  estimateBytes: 4 * 1024 ** 3,
  reserveBytes: 2 * 1024 ** 3,
  reserveInodes: 100_000,
});
const lease = storage.acquire();
const alias = `${source}-cancel-import`;
const archive = join(lease.directory, 'image.tar');
// Stay below Unix socket path limits independently of the workspace path.
const socket = `/tmp/verity-import-probe-${process.pid}.sock`;
const cli = (...args) =>
  execFileSync('docker', args, { timeout: 30_000, maxBuffer: 1024 ** 2, encoding: 'utf8' });
let upload;
let uploadedBytes = 0;
let resolveStart;
let resolveEnd;
const started = new Promise((resolve) => {
  resolveStart = resolve;
});
const ended = new Promise((resolve) => {
  resolveEnd = resolve;
});
const server = createServer((incoming, outgoing) => {
  const loading = /\/images\/load(?:\?|$)/.test(incoming.url);
  const upstream = request({
    socketPath: '/var/run/docker.sock',
    method: incoming.method,
    path: incoming.url,
    // Chunked framing lets the test close a partial upload and still observe
    // the Engine handler's terminal error instead of losing its response.
    headers: { 'content-type': incoming.headers['content-type'] ?? 'application/x-tar' },
  });
  upstream.on('error', (error) => {
    resolveEnd({ error: error.code });
    outgoing.destroy();
  });
  upstream.on('response', (response) => {
    if (!loading) {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
      return;
    }
    let body = '';
    response.on('data', (chunk) => {
      body = (body + chunk).slice(-65536);
    });
    response.on('end', () => {
      resolveEnd({ status: response.statusCode, body });
      outgoing.end(body);
    });
  });
  if (!loading) {
    incoming.pipe(upstream);
    return;
  }
  upload = { incoming, upstream };
  incoming.once('data', (chunk) => {
    const prefix = chunk.subarray(0, 16384);
    upstream.write(prefix, () => {
      uploadedBytes = prefix.length;
      resolveStart();
    });
    incoming.pause();
  });
});
let pending;
const abort = new AbortController();
const bounded = async (promise) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Import cancellation did not settle')), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
try {
  lease.reserveBuild();
  cli('tag', source, alias);
  cli('save', '--output', archive, alias);
  cli('image', 'rm', alias);
  server.listen(socket);
  await once(server, 'listening');
  pending = lease
    .run('docker', ['load', '--input', archive], {
      env: { PATH: process.env.PATH, DOCKER_HOST: `unix://${socket}` },
      signal: abort.signal,
      remoteOperation: 'image-import',
      timeout: 30_000,
      maxBuffer: 1024 ** 2,
    })
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: String(error) }),
    );
  await bounded(started);
  assert(uploadedBytes > 0, 'No import bytes reached the real Engine');
  abort.abort();
  assert.equal((await bounded(pending)).ok, false);
  // Observe the Engine's partial-input terminal response while closing the
  // now-dead client's transport. This does not prove arbitrary daemon-internal
  // cleanup after a direct socket disconnect; that remains a separate check.
  upload.incoming.destroy();
  upload.upstream.end();
  const response = await bounded(ended);
  assert.equal(response.status, 200, 'The Engine must return a terminal import response');
  assert.match(response.body, /error|unexpected EOF/i);
  await delay(1000);
  assert.throws(() => cli('image', 'inspect', alias));
  cli('image', 'inspect', source);
  // Production cannot infer completion from this test transport's observation.
  // Keep the reservation even after the test saw a terminal partial-input error.
  assert.equal(lease.retainArtifacts, true);
  assert(existsSync(archive));
  assert(existsSync(join(lease.directory, 'remote-operation.json')));
  await assert.rejects(
    lease.run('docker', ['load', '--input', archive], {
      env: { PATH: process.env.PATH, DOCKER_HOST: 'unix:///var/run/docker.sock' },
      remoteOperation: 'image-import',
      timeout: 30_000,
      maxBuffer: 1024 ** 2,
    }),
    /termination is unconfirmed/,
  );
  lease.dispose();
  // A later attempt is admitted; the unconfirmed one keeps its record and
  // reserves its estimate until reconciliation proves the import ended.
  storage.acquire().dispose();
  assert(existsSync(join(lease.directory, 'remote-operation.json')));
  assert(
    storage.unresolvedAttempts().some((attempt) => lease.directory.endsWith(`/${attempt.attempt}`)),
    'The unconfirmed import must stay reserved',
  );
  writeFileSync(
    join(process.env.PROBE_EVIDENCE, 'import-cancellation.json'),
    JSON.stringify({
      schemaVersion: 1,
      uploadedBytes,
      response,
      reservation: 'retained',
      sameAttemptImport: 'blocked-pending-reconciliation',
      laterAttempt: 'admitted-with-reservation',
      limitation:
        'Controlled partial-input transport; direct-disconnect daemon cleanup is not established',
    }),
  );
  console.log(
    'PASS: cancelled real load client; uncertain remote reservation retained, same-attempt reuse blocked',
  );
} finally {
  abort.abort();
  upload?.incoming.destroy();
  upload?.upstream.destroy();
  await pending;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  try {
    cli('image', 'rm', alias);
  } catch {
    /* Alias may never have been imported. */
  }
  lease.dispose();
  // This dedicated disposable root remains intact as evidence; other probes
  // use independent roots instead of pretending cancellation released it.
  if (lease.retainArtifacts)
    assert.deepEqual(readdirSync(process.env.PROBE_STORAGE_ROOT), [
      lease.directory.split('/').at(-1),
    ]);
}
