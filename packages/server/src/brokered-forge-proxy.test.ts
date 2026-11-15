import { createForgejoForgeAdapter } from './brokered-forge-forgejo.js';
import { createGhcrForgeAdapter } from './brokered-forge-ghcr.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  request,
  type Server,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServer as createNetServer,
  createConnection,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import Fastify from 'fastify';
import { startProjectInternalUnixListener } from './internal-listener.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type TurnCredentials } from './turn-credentials.js';
import { createBrokeredForgeProxy } from './brokered-http-tool.js';
import { createGitHubForgeAdapter, type ForgeAction } from './brokered-forge-github.js';
import {
  createProjectEgressCa,
  issueGatewayServerCertificate,
  type EgressCa,
  type PemCertificate,
} from './claude-egress-ca.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';

const cap = 'c'.repeat(43);

const token = 'ghs_server_only_test_credential';

const SANDBOX_USER = '00000000-0000-4000-8000-000000000001';

const identity = {
  projectId: 'p1',
  userId: SANDBOX_USER,
  projectDefault: true,
  containerGeneration: 'g1',
};

const binding = {
  projectId: identity.projectId,
  userId: identity.userId,
  containerGeneration: identity.containerGeneration,
  owner: 'acme',
  repo: 'app',
};

/** The capability bindings of the project's sandboxes: the default one and the
 *  personal sandboxes the badge tests present from. */
const sandboxBindings = [binding, { ...binding, userId: 'lena' }, { ...binding, userId: 'bob' }];

const capabilities: GhTokenCapabilityRegistry = {
  issue: async () => cap,
  resolve: async (value) => (value === cap ? binding : undefined),
  bindingForSandbox: async (projectId, userId) =>
    sandboxBindings.find((b) => b.projectId === projectId && b.userId === userId),
  revokeProject: async () => {},
  revokeSandbox: async () => {},
};

const allActions = new Set<ForgeAction>([
  'git-read',
  'git-write',
  'issues-read',
  'issues-write',
  'pulls-read',
  'pulls-write',
  'checks-read',
  'repository-rules-read',
  'actions-read',
  'actions-write',
  'releases-read',
  'releases-write',
]);

let ca: EgressCa;

let certificate: PemCertificate;

let dir: string;

const servers: Array<Server | NetServer> = [];

const cleanups: Array<() => Promise<void>> = [];

const sockets = new Set<Socket>();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verity-forge-test-'));
  ca = await createProjectEgressCa();
  certificate = await issueGatewayServerCertificate(ca, {
    serverName: 'github.com',
    additionalServerNames: ['api.github.com', 'uploads.github.com', 'ghcr.io'],
  });
  await writeFile(join(dir, 'ca.crt'), ca.caCertPem);
  await writeFile(join(dir, 'cap'), cap);
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  vi.restoreAllMocks();
});

afterAll(async () => rm(dir, { recursive: true, force: true }));

async function listen(server: Server | NetServer): Promise<number> {
  servers.push(server);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as { port: number }).port;
}

async function harness(
  handler: (...args: Parameters<RequestListener>) => unknown,
  options: {
    generation?: string;
    actions?: Set<ForgeAction>;
    enabled?: boolean;
    registry?: boolean;
    forgejo?: boolean;
    capabilities?: GhTokenCapabilityRegistry;
    mint?: () => Promise<string>;
    resolveRepository?: Parameters<typeof createBrokeredForgeProxy>[0]['resolveRepository'];
    transport?: BrokeredHttpStreamTransport;
    certificateFor?: (hostname: string) => Promise<PemCertificate>;
    turnCredentials?: TurnCredentials;
    personalTokens?: Record<string, string>;
    /** Serve a person's own sandbox instead of the project's default one. */
    sandboxUser?: string;
    authorizationRecheck?: { intervalMs?: number; unconfirmedLimitMs?: number };
  } = {},
) {
  const upstreamPort = await listen(
    createServer((req, res) => {
      void (async () => handler(req, res))().catch(() => res.destroy());
    }),
  );
  const received: Array<{ path: string; auth: string | undefined; body: Buffer }> = [];
  const transport: BrokeredHttpStreamTransport = async (input) => {
    const body = Buffer.isBuffer(input.body)
      ? input.body
      : await (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of input.body) chunks.push(Buffer.from(chunk as Uint8Array));
          return Buffer.concat(chunks);
        })();
    received.push({ path: input.path, auth: input.headers.authorization, body });
    return await new Promise<IncomingMessage>((done, reject) => {
      const outgoing = request(
        {
          hostname: '127.0.0.1',
          port: upstreamPort,
          path: input.path,
          method: input.method,
          headers: input.headers,
          signal: input.signal,
        },
        done,
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
  const mint = vi.fn(options.mint ?? (async () => token));
  const adapter = options.registry
    ? createGhcrForgeAdapter({
        packages: async () => ['acme/app/server'],
        mint: async () => token,
        transport,
      })
    : options.forgejo
      ? createForgejoForgeAdapter({
          connectionId: 'forge',
          baseUrl: 'https://forge.test:8443/prefix',
          credentials: () => Promise.resolve({ token, login: 'acme' }),
        })
      : createGitHubForgeAdapter({
          mint,
          transport,
          ...(options.personalTokens
            ? {
                mintForUser: async (userId: string) => options.personalTokens?.[userId],
                mayUseInstallationToken: async () => false,
              }
            : {}),
        });
  const proxy = createBrokeredForgeProxy({
    certificate,
    capabilities: options.forgejo
      ? {
          ...capabilities,
          resolve: (value) =>
            Promise.resolve(value === cap ? { ...binding, forgeConnectionId: 'forge' } : undefined),
        }
      : (options.capabilities ?? capabilities),
    ...(options.forgejo
      ? { certificateFor: () => issueGatewayServerCertificate(ca, { serverName: 'forge.test' }) }
      : {}),
    adapter,
    transport: options.transport ?? transport,
    ...(options.certificateFor ? { certificateFor: options.certificateFor } : {}),
    ...(options.resolveRepository ? { resolveRepository: options.resolveRepository } : {}),
    ...(options.turnCredentials ? { turnCredentials: options.turnCredentials } : {}),
    ...(options.authorizationRecheck ? { authorizationRecheck: options.authorizationRecheck } : {}),
    enabled: () => options.enabled ?? true,
    actions: () => options.actions ?? allActions,
  });
  const app = Fastify();
  await app.ready();
  const socketRoot = await mkdtemp(join(dir, 'project-socket-'));
  const listener = await startProjectInternalUnixListener(app, {
    socketRoot,
    identity: {
      ...identity,
      ...(options.sandboxUser !== undefined
        ? { userId: options.sandboxUser, projectDefault: false }
        : {}),
      containerGeneration: options.generation ?? identity.containerGeneration,
    },
    ownerUid: process.getuid!(),
    relayGid: process.getgid!(),
    forgeProxy: proxy,
  });
  let closed = false;
  const retire = async () => {
    if (closed) return;
    closed = true;
    await listener.close();
  };
  cleanups.push(async () => {
    await retire();
    await app.close();
  });
  const server = createNetServer((socket) => {
    const upstream = createConnection({ path: listener.socketPath });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const port = await listen(server);
  return { port, received, mint, retire };
}

async function call(
  port: number,
  path: string,
  auth = `Bearer verity-broker-${cap}`,
  host = 'api.github.com',
  body?: string | Buffer,
  connection?: string,
  method?: string,
  encoding?: string,
): Promise<{ status: number; body: string; length?: string }> {
  return await new Promise((done, reject) => {
    const outer = request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: `${host}:443` });
    outer.on('error', reject);
    outer.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done({ status: res.statusCode ?? 0, body: '' });
        return;
      }
      const tls = connect({ socket, servername: host, ca: ca.caCertPem });
      tls.on('error', reject);
      const inner = request(
        {
          hostname: host,
          path,
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: {
            host,
            authorization: auth,
            ...(encoding ? { 'content-encoding': encoding } : {}),
            ...(connection === undefined ? {} : { connection }),
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          },
          createConnection: () => tls,
        },
        (response) => {
          let result = '';
          response.on('data', (value: Buffer) => {
            result += value.toString();
          });
          response.on('error', reject);
          response.on('end', () =>
            done({
              status: response.statusCode ?? 0,
              body: result,
              ...(response.headers['content-length'] === undefined
                ? {}
                : { length: response.headers['content-length'] }),
            }),
          );
        },
      );
      inner.on('error', reject);
      inner.end(body);
    });
    outer.end();
  });
}

it('does not dispatch a Forge request revoked while adapter credentials are resolving', async () => {
  let valid = true;
  const h = await harness((_req, res) => res.end('unexpected'), {
    capabilities: { ...capabilities, resolve: async () => (valid ? binding : undefined) },
    mint: async () => {
      valid = false;
      return token;
    },
  });
  const result = await call(h.port, '/repos/acme/app/issues');
  expect(result.status).toBe(401);
  expect(h.received).toHaveLength(0);
});

it('closes an existing Forge stream when its exact capability is revoked', async () => {
  let valid = true;
  let received!: () => void;
  const admitted = new Promise<void>((resolve) => {
    received = resolve;
  });
  const h = await harness(
    (_req, res) => {
      res.write('frame');
      received();
    },
    { capabilities: { ...capabilities, resolve: async () => (valid ? binding : undefined) } },
  );
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = call(h.port, '/repos/acme/app/issues').catch(() => ({ status: 0, body: '' }));
  await admitted;
  valid = false;
  await result;
  expect(h.received).toHaveLength(1);
  expect(warning).toHaveBeenCalledWith(
    'Forge broker connection failed',
    expect.objectContaining({ phase: 'authorization', reason: 'binding-mismatch' }),
  );
});

/** An upstream that streams `frames` chunks over `durationMs`, like a first clone. */
function slowStream(frames: number, durationMs: number) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    let sent = 0;
    const timer = setInterval(() => {
      res.write(`frame${sent}\n`);
      if (++sent === frames) {
        clearInterval(timer);
        res.end();
      }
    }, durationMs / frames);
    res.once('close', () => clearInterval(timer));
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

it('keeps a live Forge stream when revocation re-checks are slower than one poll', async () => {
  // Event-loop stalls or a slow store made each re-check exceed the old 1 s
  // deadline, which cut every long first clone with an opaque authorization error.
  let calls = 0;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = await harness(slowStream(10, 2500), {
    capabilities: {
      ...capabilities,
      resolve: async (value) => {
        // Admission and the pre-dispatch check stay fast; live re-checks are slow.
        if (++calls > 2) await delay(1200);
        return value === cap ? binding : undefined;
      },
    },
    authorizationRecheck: { intervalMs: 100, unconfirmedLimitMs: 5000 },
  });
  const result = await call(h.port, '/repos/acme/app/issues');
  expect(result.status).toBe(200);
  expect(result.body.split('\n').filter(Boolean)).toHaveLength(10);
  expect(calls).toBeGreaterThan(2);
  expect(warning).not.toHaveBeenCalled();
});

it('does not count an event-loop stall against a live Forge stream', async () => {
  // A blocked loop delays every re-check at once; counted as store latency,
  // a stall longer than the bound would revoke a healthy clone.
  let calls = 0;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = await harness(
    (_req, res) => {
      let sent = 0;
      const timer = setInterval(() => {
        res.write(`frame${sent}\n`);
        if (sent === 3) {
          const until = Date.now() + 2000;
          while (Date.now() < until);
        }
        if (++sent === 8) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      res.once('close', () => clearInterval(timer));
    },
    {
      capabilities: {
        ...capabilities,
        resolve: async (value) => {
          if (++calls > 2) await delay(100);
          return value === cap ? binding : undefined;
        },
      },
      authorizationRecheck: { intervalMs: 50, unconfirmedLimitMs: 1500 },
    },
  );
  const result = await call(h.port, '/repos/acme/app/issues');
  expect(result.status).toBe(200);
  expect(result.body.split('\n').filter(Boolean)).toHaveLength(8);
  expect(warning).not.toHaveBeenCalled();
});

it('closes a live Forge stream that no re-check confirms within the bound', async () => {
  let calls = 0;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = await harness(slowStream(20, 4000), {
    capabilities: {
      ...capabilities,
      // A wedged store: live re-checks never settle.
      resolve: (value) =>
        ++calls > 2 ? new Promise(() => {}) : Promise.resolve(value === cap ? binding : undefined),
    },
    authorizationRecheck: { intervalMs: 50, unconfirmedLimitMs: 400 },
  });
  const result = await call(h.port, '/repos/acme/app/issues').catch(() => ({
    status: 0,
    body: '',
  }));
  expect(result.body.split('\n').filter(Boolean).length).toBeLessThan(20);
  expect(warning).toHaveBeenCalledWith(
    'Forge broker connection failed',
    expect.objectContaining({ phase: 'authorization', reason: 'revocation-timeout' }),
  );
});

it('closes a live Forge stream whose re-checks keep failing, naming the resolver', async () => {
  let calls = 0;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = await harness(slowStream(20, 4000), {
    capabilities: {
      ...capabilities,
      resolve: async (value) => {
        if (++calls > 2) throw new Error(`store failed for ${token}`);
        return value === cap ? binding : undefined;
      },
    },
    authorizationRecheck: { intervalMs: 50, unconfirmedLimitMs: 400 },
  });
  const result = await call(h.port, '/repos/acme/app/issues').catch(() => ({
    status: 0,
    body: '',
  }));
  expect(result.body.split('\n').filter(Boolean).length).toBeLessThan(20);
  expect(warning).toHaveBeenCalledWith('Forge broker connection failed', {
    connectionId: expect.any(String),
    phase: 'authorization',
    code: 'UNKNOWN',
    reason: 'resolver-error',
  });
});

it('validates GraphQL against additional current assignments and rechecks revocation', async () => {
  let assigned = true;
  const extra = { ...binding, owner: 'other', repo: 'api' };
  const h = await harness(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { repository: { id: 'repository-id' } } }));
    },
    {
      resolveRepository: async (_binding, _host, path) =>
        path === '/graphql' ? (assigned ? [binding, extra] : [binding]) : binding,
    },
  );
  const body = JSON.stringify({
    query: 'query { repository(owner: "other", name: "api") { id } }',
  });
  expect((await call(h.port, '/graphql', undefined, 'api.github.com', body)).status).toBe(200);
  expect(h.received).toHaveLength(1);
  assigned = false;
  expect((await call(h.port, '/graphql', undefined, 'api.github.com', body)).status).not.toBe(200);
  expect(h.received).toHaveLength(1);
});
