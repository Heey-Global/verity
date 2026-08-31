import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { request, type Server as HttpServer } from 'node:http';
import { chmodSync, lstatSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  markInternalConnections,
  internalConnectionIdentity,
  PROJECT_UDS_ROUTES,
  requestArrivedInternally,
  startInternalListener,
  startProjectInternalUnixListener,
  unlinkOwnedUnixSocket,
  type InternalListener,
  type ProjectInternalUnixListener,
} from './internal-listener.js';

describe('unlinkOwnedUnixSocket', () => {
  it('does not unlink a successor that rebound the same handoff path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-owned-uds-'));
    const socketPath = join(dir, 'relay.sock');
    const outgoing = createServer();
    await new Promise<void>((resolve) => outgoing.listen(socketPath, resolve));
    const outgoingSocket = lstatSync(socketPath);
    await new Promise<void>((resolve) => outgoing.close(() => resolve()));

    const incoming = createServer();
    await new Promise<void>((resolve) => incoming.listen(socketPath, resolve));
    unlinkOwnedUnixSocket(socketPath, outgoingSocket);

    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await new Promise<void>((resolve) => incoming.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
});

// The guard only inspects `.raw.socket`, so a minimal shim is enough here.
const reqWith = (socket: object): FastifyRequest =>
  ({ raw: { socket } }) as unknown as FastifyRequest;
const TEST_UID = process.getuid?.() ?? 1000;
const TEST_GID = process.getgid?.() ?? 1000;

describe('internal-listener socket tagging', () => {
  it('requestArrivedInternally is true only for a socket the listener accepted', () => {
    const server = new EventEmitter();
    markInternalConnections(server as unknown as HttpServer);

    const tagged = {};
    server.emit('connection', tagged);
    const untagged = {};

    expect(requestArrivedInternally(reqWith(tagged))).toBe(true);
    expect(requestArrivedInternally(reqWith(untagged))).toBe(false);
    expect(internalConnectionIdentity(reqWith(tagged))).toBeUndefined();
  });

  it('binds project identity to accepted sockets without reading request data', () => {
    const server = new EventEmitter();
    const identity = { projectId: 'project-a', containerGeneration: 'generation-1' };
    markInternalConnections(server as unknown as HttpServer, identity);
    const tagged = {};
    server.emit('connection', tagged);

    expect(internalConnectionIdentity(reqWith(tagged))).toEqual(identity);
  });
});

describe('startInternalListener (shared handler, separate socket)', () => {
  let app: FastifyInstance | undefined;
  let listener: InternalListener | undefined;
  afterEach(async () => {
    await listener?.close();
    await app?.close();
    listener = undefined;
    app = undefined;
  });

  it('serves /internal/* on the internal socket but 404s it on the public one', async () => {
    app = Fastify();
    // The same gate server.ts installs: /internal/* is 404 unless the request
    // arrived on an internal (tagged) socket.
    app.addHook('onRequest', async (request, reply) => {
      const pathname = request.url.split('?', 1)[0] ?? request.url;
      if (pathname.startsWith('/internal/') && !requestArrivedInternally(request)) {
        // Mirror the production gate: send()+return actually short-circuits (a bare
        // `return {payload}` from an async onRequest hook is discarded by Fastify).
        return reply.code(404).send({ error: 'not found' });
      }
    });
    app.get('/internal/ping', () => ({ ok: true }));
    app.get('/ping', () => ({ ok: true }));
    await app.ready();

    listener = await startInternalListener(app, 0, '127.0.0.1');

    // On the dedicated internal socket the route is reachable…
    const internal = await fetch(`http://127.0.0.1:${listener.port}/internal/ping`);
    expect(internal.status).toBe(200);
    expect(await internal.json()).toEqual({ ok: true });

    // …but a request that did NOT arrive on that socket (inject → untagged) 404s.
    const publicHit = await app.inject({ method: 'GET', url: '/internal/ping' });
    expect(publicHit.statusCode).toBe(404);

    // Non-internal paths are served normally on the internal listener too.
    const plain = await fetch(`http://127.0.0.1:${listener.port}/ping`);
    expect(plain.status).toBe(200);
  });
});

function unixRequest(
  socketPath: string,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.once('error', reject);
    req.end();
  });
}

describe('startProjectInternalUnixListener', () => {
  let app: FastifyInstance | undefined;
  let listener: ProjectInternalUnixListener | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await listener?.close();
    await app?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    listener = undefined;
    app = undefined;
    dir = undefined;
  });

  it('binds identity and permits only the project broker route set', async () => {
    app = Fastify();
    app.post('/internal/github/token', (request) => ({
      identity: internalConnectionIdentity(request),
    }));
    app.post('/internal/project/memory', () => ({ ok: true }));
    app.post('/internal/git/sign', () => ({ unsafe: true }));
    app.get('/projects', () => ({ unsafe: true }));
    await app.ready();

    dir = mkdtempSync(join(tmpdir(), 'verity-project-uds-'));
    const identity = { projectId: 'project-a', containerGeneration: 'generation-1' };
    listener = await startProjectInternalUnixListener(app, {
      socketRoot: dir,
      identity,
      ownerUid: TEST_UID,
      relayGid: TEST_GID,
    });

    expect(statSync(dirname(listener.socketPath)).mode & 0o777).toBe(0o710);
    expect(statSync(listener.socketPath)).toMatchObject({
      uid: TEST_UID,
      gid: TEST_GID,
    });
    expect(statSync(listener.socketPath).mode & 0o777).toBe(0o660);
    const allowed = await unixRequest(listener.socketPath, 'POST', '/internal/github/token');
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toEqual({ identity });
    await expect(
      startProjectInternalUnixListener(app, {
        socketRoot: dir,
        identity,
        ownerUid: TEST_UID,
        relayGid: TEST_GID,
      }),
    ).rejects.toThrow('socket is already active');

    await expect(
      unixRequest(listener.socketPath, 'GET', '/internal/github/token'),
    ).resolves.toMatchObject({
      status: 404,
    });
    await expect(
      unixRequest(listener.socketPath, 'POST', '/internal/git/sign'),
    ).resolves.toMatchObject({
      status: 200,
    });
    await expect(unixRequest(listener.socketPath, 'GET', '/projects')).resolves.toMatchObject({
      status: 404,
    });
  });

  it('rejects an empty project or generation identity before binding', async () => {
    app = Fastify();
    await app.ready();
    dir = mkdtempSync(join(tmpdir(), 'verity-project-uds-invalid-'));

    await expect(
      startProjectInternalUnixListener(app, {
        socketRoot: dir,
        identity: { projectId: '', containerGeneration: 'generation-1' },
        ownerUid: TEST_UID,
        relayGid: TEST_GID,
      }),
    ).rejects.toThrow('requires project and container-generation identity');
  });

  it('destroys held connections during bounded teardown', async () => {
    app = Fastify();
    await app.ready();
    dir = mkdtempSync(join(tmpdir(), 'verity-project-uds-close-'));
    listener = await startProjectInternalUnixListener(app, {
      socketRoot: dir,
      identity: { projectId: 'project-a', containerGeneration: 'generation-1' },
      ownerUid: TEST_UID,
      relayGid: TEST_GID,
    });
    const held = createConnection({ path: listener.socketPath });
    await new Promise<void>((resolve, reject) => {
      held.once('connect', resolve);
      held.once('error', reject);
    });

    const clientClosed = once(held, 'close');
    await listener.close();
    listener = undefined;
    await clientClosed;
    expect(held.destroyed).toBe(true);
  });

  it('reconciles a stale socket but refuses a hostile regular-file path', async () => {
    app = Fastify();
    await app.ready();
    dir = mkdtempSync(join(tmpdir(), 'verity-project-uds-stale-'));
    const identity = { projectId: 'project-a', containerGeneration: 'generation-1' };
    listener = await startProjectInternalUnixListener(app, {
      socketRoot: dir,
      identity,
      ownerUid: TEST_UID,
      relayGid: TEST_GID,
    });
    const socketPath = listener.socketPath;
    await listener.close();
    listener = undefined;
    const stale = spawn(
      process.execPath,
      [
        '-e',
        "const n=require('node:net');n.createServer().listen(process.argv[1],()=>console.log('ready'));setInterval(()=>{},1000)",
        socketPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      stale.once('error', reject);
      stale.once('exit', (code) =>
        reject(new Error(`stale fixture exited early: ${String(code)}`)),
      );
      stale.stdout.once('data', () => resolve());
    });
    stale.kill('SIGKILL');
    await once(stale, 'exit');
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    listener = await startProjectInternalUnixListener(app, {
      socketRoot: dir,
      identity,
      ownerUid: TEST_UID,
      relayGid: TEST_GID,
    });
    await listener.close();
    listener = undefined;

    writeFileSync(socketPath, 'hostile');
    await expect(
      startProjectInternalUnixListener(app, {
        socketRoot: dir,
        identity,
        ownerUid: TEST_UID,
        relayGid: TEST_GID,
      }),
    ).rejects.toThrow('refuses a non-socket broker path');
  });

  it('refuses an untrusted existing root without changing its permissions', async () => {
    app = Fastify();
    await app.ready();
    dir = mkdtempSync(join(tmpdir(), 'verity-project-uds-untrusted-'));
    chmodSync(dir, 0o777);

    await expect(
      startProjectInternalUnixListener(app, {
        socketRoot: dir,
        identity: { projectId: 'project-a', containerGeneration: 'generation-1' },
        ownerUid: TEST_UID,
        relayGid: TEST_GID,
      }),
    ).rejects.toThrow('requires a trusted Verity-owned socket root');
    expect(statSync(dir).mode & 0o777).toBe(0o777);
  });
});

// The project relay is the only hop between a Sandbox and this socket, and it enforces
// its own forwarding allowlist. A route added here but not there is not merely
// unauthenticated — it 404s at the relay and is unreachable from the Sandbox however the
// Server is composed. `POST /internal/mcp` shipped that way, so every ACP session got a
// gateway URL that answered like a route that does not exist.
//
// Read as source rather than imported: the relay is a deliberately dependency-free
// sidecar, and this invariant is not worth making the Server build depend on it.
describe('project relay route drift', () => {
  const relaySource = readFileSync(
    fileURLToPath(new URL('../../project-relay/src/relay.ts', import.meta.url)),
    'utf8',
  );

  it('forwards every route the project socket terminates', () => {
    const literal = /BROKER_RELAY_ROUTES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/u.exec(relaySource)?.[1];
    // A parse miss would silently pass the comparison below, so fail on it directly.
    expect(literal, 'BROKER_RELAY_ROUTES literal not found in the relay source').toBeDefined();
    // Comments first: an apostrophe in prose would otherwise open a quote that closes
    // on the next real route and swallow it.
    const entries = literal!.replaceAll(/\/\/[^\n]*/gu, '');
    const relayRoutes = new Set(
      [...entries.matchAll(/'([^']+)'/gu)].map((match) => match[1] as string),
    );
    expect(relayRoutes.size).toBeGreaterThan(0);
    expect([...PROJECT_UDS_ROUTES].sort()).toEqual([...relayRoutes].sort());
  });
});
