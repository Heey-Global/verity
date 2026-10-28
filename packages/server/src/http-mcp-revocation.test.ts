import { InMemoryEventBus, type Conductor } from '@verity/session';
import { EventStore, createSealableSecretCipher } from '@verity/store';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { startProjectInternalUnixListener } from './internal-listener.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';
import { buildServer } from './server.js';
import { createAuthTokenRegistry } from './auth.js';

// Only the provider transport is simulated. Admission, binding lookup, bearer
// revocation and SSE polling run through the server's actual composition.
const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: transport.request,
}));

let ctx: TestDb;
beforeAll(async () => {
  // Advancing fake timers cannot await PostgreSQL socket I/O during polling.
  ctx = await createIsolatedTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  transport.request.mockReset();
});

async function fixture() {
  const cipher = createSealableSecretCipher();
  cipher.unlock('ab'.repeat(32));
  const store = new EventStore(ctx.db, cipher);
  await store.createProject({
    id: 'p',
    owner: '__local__',
    repo: 'p',
    kind: 'local',
    containerName: 'verity-p',
    cloneDir: '/work/p',
    state: 'active',
  });
  await store.createSession({ sessionId: 's', projectId: 'p', worktree: '/work/s', model: 'test' });
  const connection = {
    id: 'connection',
    name: 'provider',
    url: 'https://mcp.example.test',
    authorization: 'Bearer synthetic-account-a',
    enabled: true,
  };
  await store.upsertHttpMcpConnection(connection);
  await store.upsertProjectMcpBinding({
    projectId: 'p',
    connectionId: connection.id,
    enabled: true,
  });
  const tokens = createMcpGatewayTokens();
  const token = tokens.issue({ projectId: 'p', sessionId: 's', turnId: 't' });
  const resolveCaller = vi.fn(async (input: { projectId: string; token: string }) =>
    tokens.resolve(input),
  );
  const upstream = new PassThrough();
  const response = Object.assign(upstream, {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    setTimeout: vi.fn(),
  });
  transport.request.mockImplementation(
    (_options: RequestOptions, callback: (r: IncomingMessage) => void) => {
      const outgoing = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn(),
        end: () => {
          callback(response as unknown as IncomingMessage);
          upstream.write('data: admitted\n\n');
        },
      });
      return outgoing;
    },
  );
  const app = buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    secretCipher: cipher,
    authRegistry: await createAuthTokenRegistry(store, { enabled: true }),
    mcpProxyResolveCaller: resolveCaller,
    conductor: {} as Conductor,
  });
  await app.ready();
  const dir = await mkdtemp(join(tmpdir(), 'mcp-revoke-'));
  const listener = await startProjectInternalUnixListener(app, {
    socketRoot: dir,
    identity: { projectId: 'p', containerGeneration: 'g' },
    ownerUid: process.getuid?.() ?? 1000,
    relayGid: process.getgid?.() ?? 1000,
  });
  let client: IncomingMessage | undefined;
  const open = async (presentedToken = token) => {
    client = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          socketPath: listener.socketPath,
          path: '/internal/mcp-proxy',
          headers: {
            authorization: `Bearer ${presentedToken}`,
            'x-verity-mcp-binding': connection.id,
          },
        },
        resolve,
      );
      req.on('error', reject);
      req.end();
    });
    client.on('error', () => {});
    // Receipt of a frame proves that the response has entered the streaming path.
    if (client.statusCode === 200)
      await new Promise<void>((resolve) => client!.once('data', () => resolve()));
    else client.resume();
    return client;
  };
  return {
    store,
    connection,
    tokens,
    token,
    upstream,
    open,
    resolveCaller,
    close: async () => {
      upstream.destroy();
      client?.destroy();
      vi.useRealTimers();
      await listener.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it('admits an enabled binding and keeps a valid stream alive across an authorization poll', async () => {
  const h = await fixture();
  try {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    expect((await h.open()).statusCode).toBe(200);
    await h.store.upsertHttpMcpConnection({ ...h.connection });
    const calls = h.resolveCaller.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.resolveCaller.mock.calls.length).toBeGreaterThan(calls);
    expect(h.upstream.destroyed).toBe(false);
    expect(transport.request).toHaveBeenCalledOnce();
  } finally {
    await h.close();
  }
});

it('does not overlap slow connection rechecks and closes when the lookup denies access', async () => {
  const h = await fixture();
  type Connections = Awaited<ReturnType<EventStore['listHttpMcpConnections']>>;
  let resolveLookup!: (connections: Connections) => void;
  const pending = new Promise<Connections>((resolve) => {
    resolveLookup = resolve;
  });
  try {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    expect((await h.open()).statusCode).toBe(200);
    const lookup = vi
      .spyOn(h.store, 'listHttpMcpConnections')
      .mockImplementationOnce(() => pending);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lookup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(lookup).toHaveBeenCalledOnce();
    expect(h.upstream.destroyed).toBe(false);
    resolveLookup([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.upstream.destroyed).toBe(true);
  } finally {
    resolveLookup([]);
    await h.close();
  }
});

it.each(['binding', 'bearer'] as const)(
  'refuses a revoked %s before provider dispatch',
  async (kind) => {
    const h = await fixture();
    try {
      if (kind === 'binding') await h.store.deleteProjectMcpBinding('p', h.connection.id);
      else h.tokens.release({ projectId: 'p', token: h.token });
      expect((await h.open()).statusCode).toBe(401);
      expect(transport.request).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  },
);

it('characterizes explicit project binding as shared with another executing member', async () => {
  const h = await fixture();
  try {
    await sql`insert into users (id, role, status) values ('member', 'member', 'active')`.execute(
      ctx.db,
    );
    await sql`insert into project_memberships (project_id, user_id, can_read, can_execute, can_manage)
      values ('p', 'member', true, true, false)`.execute(ctx.db);
    await h.store.createSession({
      sessionId: 'other',
      projectId: 'p',
      worktree: '/work/other',
      model: 'test',
    });
    const prompt = await h.store.appendEvent('other', {
      t: 'prompt',
      text: 'Use the shared connection',
      initiatedBy: { userId: 'member' },
    });
    await h.store.markTurnRunning({ sessionId: 'other', promptSeq: prompt.seq });
    await h.store.bindTurnIdentity('other', { turnId: 'other-turn', startCommandId: 'start' });
    expect(await h.store.listHttpMcpConnections('member')).toEqual([]);
    expect(await h.store.hasProjectPermission('member', 'p', 'execute')).toBe(true);
    const token = h.tokens.issue({ projectId: 'p', sessionId: 'other', turnId: 'other-turn' });
    expect((await h.open(token)).statusCode).toBe(200);
    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer synthetic-account-a' }),
      }),
      expect.any(Function),
    );
  } finally {
    await h.close();
  }
});

for (const kind of [
  'bearer',
  'binding',
  'connection',
  'account',
  'endpoint',
  'lookup-error',
] as const) {
  it(`closes an admitted stream after ${kind} authority changes`, async () => {
    const h = await fixture();
    try {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const client = await h.open();
      expect(client.statusCode).toBe(200);
      if (kind === 'bearer') h.tokens.release({ projectId: 'p', token: h.token });
      if (kind === 'binding') await h.store.deleteProjectMcpBinding('p', h.connection.id);
      if (kind === 'connection')
        await h.store.upsertHttpMcpConnection({ ...h.connection, enabled: false });
      if (kind === 'account')
        await h.store.upsertHttpMcpConnection({
          ...h.connection,
          authorization: 'Bearer synthetic-account-b',
        });
      if (kind === 'endpoint')
        await h.store.upsertHttpMcpConnection({
          ...h.connection,
          url: 'https://other.example.test',
        });
      if (kind === 'lookup-error')
        vi.spyOn(h.store, 'listHttpMcpConnections').mockRejectedValueOnce(
          new Error('synthetic lookup failure'),
        );
      const calls = h.resolveCaller.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.resolveCaller.mock.calls.length).toBeGreaterThan(calls);
      expect(h.upstream.destroyed).toBe(true);
    } finally {
      await h.close();
    }
  });
}
