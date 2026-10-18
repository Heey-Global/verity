import { createHash } from 'node:crypto';
import { createFrameProxy } from './tls-frame-proxy.ts';
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
  suppressDataFrom(party: 'app' | 'installation', enabled: boolean): void;
  close(): Promise<void>;
}
interface UplinkAdapter {
  createRemoteIntegrationFixture(options: {
    tls: { key: Buffer; cert: Buffer };
    lifetimeMs: number;
  }): Promise<UplinkFixture>;
}

// The adapter belongs to the Uplink checkout; this runner never substitutes a copied relay.
const [uplinkRoot, directory, pin, scenario = 'baseline'] = process.argv.slice(2);
if (!uplinkRoot || !directory || !pin)
  throw new Error('Expected Uplink checkout, temporary directory and test pin');
const artifactDirectory = directory;
const revision = execFileSync('git', ['-C', uplinkRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const coreRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const adapter = (await import(
  pathToFileURL(resolve(uplinkRoot, 'packages/uplink/dist/testing/remote-integration-fixture.js'))
    .href
)) as UplinkAdapter;
const tls = {
  key: await readFile(resolve(artifactDirectory, 'key.pem')),
  cert: await readFile(resolve(artifactDirectory, 'cert.pem')),
};
const pooled = ['pooled', 'frame-release', 'frame-abort'].includes(scenario);
let proxy: Awaited<ReturnType<typeof createFrameProxy>> | undefined;
let largeRequests = 0;
let smallRequests = 0;
let sendRequests = 0;
const largeBody = Buffer.alloc(8 * 1024 * 1024, 0x78);
const largeHash = createHash('sha256').update(largeBody).digest('hex');
if (!['baseline', 'loss', 'recovery', 'pooled', 'frame-release', 'frame-abort'].includes(scenario))
  throw new Error('Unknown scenario');
let echoes = 0;
let faultRequests = 0;
let faultResponseFinished = false;
let corePongsAfterFault = 0;
let coreDataCallbackAfterFault = false;
let refreshDiagnostics: (() => void) | undefined;
const diagnosticExpiry = Date.now() + 120_000;
const faultPayload = Buffer.from('withheld-native-response');
const server = createServer(tls, (request, response) => {
  if (pooled && request.url === '/control') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(proxy?.snapshot() ?? { held: false }));
    return;
  }
  if (pooled && request.url === '/release') {
    if (!proxy?.snapshot().held) {
      response.writeHead(409).end();
      return;
    }
    if (scenario === 'frame-abort') proxy.abort();
    else proxy.release();
    response.end('released');
    return;
  }
  if (pooled && request.url === '/large') {
    largeRequests++;
    if (scenario !== 'pooled') proxy!.arm();
    response.setHeader('content-length', largeBody.length);
    response.end(largeBody);
    return;
  }
  if (pooled && request.url === '/send' && request.method === 'POST') {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128) request.destroy();
      else chunks.push(chunk);
    });
    request.on('error', () => response.destroy());
    request.on('end', () => {
      if (Buffer.concat(chunks).toString() !== 'synthetic-turn') {
        response.writeHead(400).end();
        return;
      }
      sendRequests++;
      response.end('sent-ok');
    });
    return;
  }
  if (pooled && request.url === '/small') {
    smallRequests++;
    response.end('small-ok');
    return;
  }
  if (request.url === '/healthz') {
    response.end('core-ok');
    return;
  }
  if (request.url === '/fault' && request.method === 'POST' && scenario === 'loss') {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128) request.destroy();
      else chunks.push(chunk);
    });
    request.on('error', () => response.destroy());
    request.on('end', () => {
      if (!Buffer.concat(chunks).equals(Buffer.from('native-reverse-receipt'))) {
        response.writeHead(400).end();
        return;
      }
      faultRequests++;
      uplink.suppressDataFrom('installation', true);
      refreshDiagnostics?.();
      response.on('finish', () => {
        faultResponseFinished = true;
      });
      response.end(faultPayload);
    });
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
// A server idle close must not turn deliberate missing DATA into an unrelated EOF.
server.keepAliveTimeout = 60_000;
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
if (pooled) proxy = await createFrameProxy(endpoint, tls);
const pool = createRemoteConnectorPool({
  dataUrl: proxy?.dataURL ?? uplink.dataURL,
  localHost: '127.0.0.1',
  localPort: address.port,
  returnPathExpiry: () => (faultRequests > 0 ? diagnosticExpiry : undefined),
  returnPathSubscribe: (listener) => {
    refreshDiagnostics = listener;
    return () => {
      refreshDiagnostics = undefined;
    };
  },
  onReturnPathSnapshot: (snapshot) => {
    if (
      typeof snapshot !== 'object' ||
      snapshot === null ||
      !('events' in snapshot) ||
      !Array.isArray(snapshot.events)
    )
      return;
    coreDataCallbackAfterFault ||= snapshot.events.some(
      (event: unknown) =>
        typeof event === 'object' &&
        event !== null &&
        'stage' in event &&
        event.stage === 'callback' &&
        'outcome' in event &&
        event.outcome === 'accepted' &&
        'type' in event &&
        event.type === 'stream.data',
    );
  },
  webSocketFactory: (url, options) => {
    const socket = new WebSocket(url, { ...options, ca: tls.cert });
    socket.on('pong', () => {
      if (faultRequests > 0) corePongsAfterFault++;
    });
    return socket;
  },
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
  resolve(artifactDirectory, 'manifest.json'),
  JSON.stringify({
    dataURL: uplink.dataURL,
    appTicket: uplink.appTicket,
    sessionId: uplink.sessionId,
    outerPin: pin,
    corePin: pin,
    scenario,
    controlURL: `https://127.0.0.1:${address.port}`,
    largeHash,
  }),
  { mode: 0o600 },
);
await writeFile(
  resolve(artifactDirectory, 'provenance.json'),
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
  const proxyReceipt = proxy?.snapshot();
  await proxy?.close();
  await uplink.close();
  server.closeAllConnections();
  server.close();
  pool.disposeDiagnostics();
  await writeFile(
    resolve(artifactDirectory, 'core-result.json'),
    JSON.stringify({
      success:
        attached &&
        !failure &&
        echoes === 4 &&
        (!pooled ||
          (largeRequests === 1 &&
            (scenario === 'frame-abort' || (smallRequests === 2 && sendRequests === 1)) &&
            (scenario === 'pooled' ||
              (proxyReceipt?.held === true &&
                proxyReceipt.intercepted === 1 &&
                (scenario === 'frame-abort'
                  ? proxyReceipt.aborted
                  : proxyReceipt.released === 1))))) &&
        (scenario !== 'loss' ||
          (faultRequests === 1 &&
            faultResponseFinished &&
            coreDataCallbackAfterFault &&
            corePongsAfterFault > 0)),
      attached,
      proxy: proxyReceipt,
      largeRequests,
      smallRequests,
      sendRequests,
      largeHash,
      echoes,
      scenario,
      faultRequests,
      faultResponseFinished,
      corePongsAfterFault,
      coreDataCallbackAfterFault,
    }),
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
