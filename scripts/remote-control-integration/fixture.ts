import { createServer } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import type * as CoreConnector from '../../packages/server/src/remote-control-connector.js';

// Lint runs before build; derive types from source while executing the built connector.
const { createRemoteConnectorPool } = (await import(
  new URL('../../packages/server/dist/remote-control-connector.js', import.meta.url).href
)) as typeof CoreConnector;

interface UplinkFixture {
  dataURL: string;
  appTicket: string;
  coreTicket: string;
  sessionId: string;
  close(): Promise<void>;
}
interface UplinkAdapter {
  createRemoteIntegrationFixture(options: {
    tls: { key: Buffer; cert: Buffer };
    lifetimeMs: number;
  }): Promise<UplinkFixture>;
}

// The adapter belongs to the Uplink checkout; this runner never substitutes a copied relay.
const [uplinkRoot, directory, pin] = process.argv.slice(2);
if (!uplinkRoot || !directory || !pin)
  throw new Error('Expected Uplink checkout, temporary directory and test pin');
const revision = execFileSync('git', ['-C', uplinkRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const coreRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const adapter = (await import(
  pathToFileURL(resolve(uplinkRoot, 'packages/uplink/dist/testing/remote-integration-fixture.js'))
    .href
)) as UplinkAdapter;
const tls = {
  key: await readFile(resolve(directory, 'key.pem')),
  cert: await readFile(resolve(directory, 'cert.pem')),
};
let echoes = 0;
const server = createServer(tls, (request, response) => {
  if (request.url === '/healthz') {
    response.end('core-ok');
    return;
  }
  if (request.url !== '/echo' || request.method !== 'POST') {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  request.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    echoes++;
    response.end(Buffer.concat(chunks));
  });
  request.on('error', () => response.destroy());
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing local TLS listener');
const uplink = await adapter.createRemoteIntegrationFixture({ tls, lifetimeMs: 120_000 });
const endpoint = new URL(uplink.dataURL);
if (
  endpoint.protocol !== 'wss:' ||
  endpoint.hostname !== '127.0.0.1' ||
  endpoint.pathname !== '/data'
) {
  await uplink.close();
  server.close();
  throw new Error('Adapter must use loopback WSS /data');
}
const pool = createRemoteConnectorPool({
  dataUrl: uplink.dataURL,
  localHost: '127.0.0.1',
  localPort: address.port,
  webSocketFactory: (url, options) => new WebSocket(url, { ...options, ca: tls.cert }),
});
const controller = new AbortController();
const reservation = await pool.reserve(
  { requestId: 'integration', sessionId: uplink.sessionId, decisionExpiresAt: Date.now() + 60_000 },
  controller.signal,
);
if (typeof reservation === 'string') throw new Error('Core reservation failed');
const session = reservation;
let attached = false;
let failure = false;
const attaching = session
  .attach(uplink.coreTicket, Date.now() + 60_000, controller.signal)
  .then(() => {
    attached = true;
  })
  .catch(() => {
    failure = true;
  });
await writeFile(
  resolve(directory, 'manifest.json'),
  JSON.stringify({
    dataURL: uplink.dataURL,
    appTicket: uplink.appTicket,
    sessionId: uplink.sessionId,
    outerPin: pin,
    corePin: pin,
  }),
  { mode: 0o600 },
);
await writeFile(
  resolve(directory, 'provenance.json'),
  JSON.stringify({ coreRevision, uplinkRevision: revision }),
  { mode: 0o600 },
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  controller.abort();
  session.release('integration finished');
  await attaching;
  await uplink.close();
  server.closeAllConnections();
  server.close();
  pool.disposeDiagnostics();
  await writeFile(
    resolve(directory, 'core-result.json'),
    JSON.stringify({ success: attached && !failure && echoes === 4, attached, echoes }),
    { mode: 0o600 },
  );
}
process.once('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
process.once('SIGINT', () => {
  void close().then(() => process.exit(130));
});
setTimeout(() => {
  void close().then(() => process.exit(1));
}, 120_000).unref();
