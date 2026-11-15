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

const SANDBOX_USER = '00000000-0000-4000-8000-000000000001';

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
  await sql`insert into users (id, role, status) values ('caller', 'member', 'active')`.execute(
    ctx.db,
  );
  await sql`insert into project_memberships (project_id, user_id, can_read, can_execute, can_manage)
    values ('p', 'caller', true, true, false)`.execute(ctx.db);
  const prompt = await store.appendEvent('s', {
    t: 'prompt',
    text: 'Use the connection',
    initiatedBy: { userId: 'caller' },
  });
  await store.markTurnRunning({ sessionId: 's', promptSeq: prompt.seq });
  await store.bindTurnIdentity('s', { turnId: 't', startCommandId: 'start' });
  const connection = {
    id: 'connection',
    name: 'provider',
    url: 'https://mcp.example.test',
    authorization: 'Bearer synthetic-account-a',
    enabled: true,
    // A credentialed connection belongs to the person who created it and serves
    // only their turns (ADR 0023 §3); the running turn here is theirs.
    ownerUserId: 'caller',
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
    identity: {
      projectId: 'p',
      userId: SANDBOX_USER,
      projectDefault: true,
      containerGeneration: 'g',
    },
    ownerUid: process.getuid?.() ?? 1000,
    relayGid: process.getgid?.() ?? 1000,
  });
  let client: IncomingMessage | undefined;
  let retired = false;
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
    retire: async () => {
      retired = true;
      await listener.close();
    },
    close: async () => {
      upstream.destroy();
      client?.destroy();
      vi.useRealTimers();
      if (!retired) await listener.close();
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

it('does not overlap slow connection rechecks and closes when the lookup stalls', async () => {
  const h = await fixture();
  type Connections = Awaited<ReturnType<EventStore['listHttpMcpConnections']>>;
  let resolveLookup!: (connections: Connections) => void;
  const pending = new Promise<Connections>((resolve) => {
    resolveLookup = resolve;
  });
  try {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    expect((await h.open()).statusCode).toBe(200);
    const lookup = vi
      .spyOn(h.store, 'listHttpMcpConnections')
      .mockImplementationOnce(() => pending);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lookup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(lookup).toHaveBeenCalledOnce();
    expect(h.upstream.destroyed).toBe(true);
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

// A project binding makes a connection visible to the project, not usable with
// its owner's credential: another member's turn must be refused before anything
// reaches the provider (ADR 0023 §3).
it("refuses another executing member's turn the owner's credentialed connection", async () => {
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
      text: "Use another person's connection",
      initiatedBy: { userId: 'member' },
    });
    await h.store.markTurnRunning({ sessionId: 'other', promptSeq: prompt.seq });
    await h.store.bindTurnIdentity('other', { turnId: 'other-turn', startCommandId: 'start' });
    expect(await h.store.listHttpMcpConnections('member')).toEqual([]);
    expect(await h.store.hasProjectPermission('member', 'p', 'execute')).toBe(true);
    const token = h.tokens.issue({ projectId: 'p', sessionId: 'other', turnId: 'other-turn' });
    expect((await h.open(token)).statusCode).toBe(401);
    expect(transport.request).not.toHaveBeenCalled();
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
  'sponsor',
] as const) {
  it(`closes an admitted stream after ${kind} authority changes`, async () => {
    const h = await fixture();
    try {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const client = await h.open();
      expect(client.statusCode).toBe(200);
      if (kind === 'bearer') h.tokens.release({ projectId: 'p', token: h.token });
      if (kind === 'sponsor')
        await sql`update project_memberships set can_execute = false where project_id = 'p' and user_id = 'caller'`.execute(
          ctx.db,
        );
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

it('generation retirement destroys an upstream stream without waiting for authorization polling', async () => {
  const h = await fixture();
  try {
    await h.open();
    expect(h.upstream.destroyed).toBe(false);
    // No timer advance: retirement itself must cancel the provider-side stream.
    await h.retire();
    expect(h.upstream.destroyed).toBe(true);
  } finally {
    await h.close();
  }
});

it('does not forward work whose caller lookup finishes after generation retirement', async () => {
  const h = await fixture();
  let complete!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.resolveCaller.mockImplementationOnce(async () => {
    entered();
    await pending;
    return { sessionId: 's', turnId: 't' };
  });
  try {
    const opened = h.open().catch(() => undefined);
    await started;
    await h.retire();
    complete();
    await opened;
    // Let the resumed route's microtasks run before checking the transport.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.request).not.toHaveBeenCalled();
  } finally {
    complete();
    await h.close();
  }
});

// The Wiki maintenance run reads untrusted text unattended; a project MCP server
// would let injected text reach the outside, so its session never gets one.
it('refuses project MCP servers to the Wiki maintenance session', async () => {
  const h = await fixture();
  try {
    await h.store.wikiMaintenance.setSession('p', 's');
    expect((await h.open()).statusCode).toBe(401);
    expect(transport.request).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
