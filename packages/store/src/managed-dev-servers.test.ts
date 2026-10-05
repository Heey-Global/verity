import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ManagedDevServerConflictError,
  ManagedDevServerInputError,
  ManagedDevServerPortsFullError,
  managedDevServerNameKey,
  normalizeManagedDevServerWorkdir,
} from './managed-dev-servers.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-p1',
    state: 'active',
  });
  for (const id of ['s1', 's2', 's3'])
    await ctx.store.createSession({
      sessionId: id,
      worktree: `/wt/${id}`,
      model: 'm',
      projectId: 'p1',
    });
});

const servers = () => ctx.store.managedDevServers;
const add = (name: string, command = 'node server.mjs', workdir?: string) =>
  servers().create({ projectId: 'p1', name, command, workdir });

describe('managed dev server entries', () => {
  // The name also names the sibling URL variable; two names that map to the same
  // variable would make one server's URL silently shadow the other's.
  it('rejects names that collide after normalization, on add and on rename', async () => {
    await add('my-api');
    await expect(add('My API')).rejects.toBeInstanceOf(ManagedDevServerConflictError);
    const web = await add('web');
    await expect(servers().update(web.id, { name: 'my_api' })).rejects.toBeInstanceOf(
      ManagedDevServerConflictError,
    );
    expect(managedDevServerNameKey('  Curtis demo! ')).toBe('CURTIS_DEMO');
  });

  it('keeps the subdirectory relative and inside the worktree', () => {
    expect(normalizeManagedDevServerWorkdir(undefined)).toBe('.');
    expect(normalizeManagedDevServerWorkdir('./apps//web/')).toBe('apps/web');
    expect(() => normalizeManagedDevServerWorkdir('/etc')).toThrow(ManagedDevServerInputError);
    expect(() => normalizeManagedDevServerWorkdir('apps/../../x')).toThrow(
      ManagedDevServerInputError,
    );
  });

  // Approval is for what the operator saw. An agent edit between seeing and
  // tapping must not inherit it, and an edit afterwards must void it.
  it('approves only the command the operator saw and voids it on change', async () => {
    const demo = await add('Demo', 'node server.mjs --port {port}', 'curtis-voice');
    expect(demo.approved).toBe(false);
    expect(
      await servers().approve(demo.id, { command: 'node other.mjs', workdir: 'curtis-voice' }),
    ).toBeUndefined();
    const approved = await servers().approve(demo.id, {
      command: 'node server.mjs --port {port}',
      workdir: 'curtis-voice',
    });
    expect(approved?.approved).toBe(true);
    const changed = await servers().update(demo.id, { command: 'node evil.mjs' });
    expect(changed?.approved).toBe(false);
    // The previously approved values still count for a restart that runs them.
    expect(
      await servers().isApproved(demo.id, 'node server.mjs --port {port}', 'curtis-voice'),
    ).toBe(true);
    expect(await servers().isApproved(demo.id, 'node evil.mjs', 'curtis-voice')).toBe(false);
  });
});

describe('managed dev server instances', () => {
  it('gives each session its own sandbox port and keeps it', async () => {
    const demo = await add('Demo');
    const ports = [4100, 4101, 4102];
    const first = await servers().ensureInstance({
      serverId: demo.id,
      sessionId: 's1',
      sandboxPorts: ports,
    });
    const second = await servers().ensureInstance({
      serverId: demo.id,
      sessionId: 's2',
      sandboxPorts: ports,
    });
    expect(first.sandboxPort).not.toBe(second.sandboxPort);
    const again = await servers().ensureInstance({
      serverId: demo.id,
      sessionId: 's1',
      sandboxPorts: ports,
    });
    expect(again).toMatchObject({ id: first.id, sandboxPort: first.sandboxPort });
    const moved = await servers().moveSandboxPort(first.id, ports, new Set([first.sandboxPort]));
    expect(moved?.sandboxPort).toBe(4102);
  });

  it('keeps a network port reserved across stops and skips ports held elsewhere', async () => {
    const demo = await add('Demo');
    const instance = await servers().ensureInstance({
      serverId: demo.id,
      sessionId: 's1',
      sandboxPorts: [4100],
    });
    const options = { protect: new Set<string>(), externallyUsed: new Set([8100]) };
    const { port } = await servers().reserveNetworkPort(instance.id, [8100, 8101], options);
    expect(port).toBe(8101);
    await servers().updateInstance(instance.id, { desired: 'stopped', state: 'stopped' });
    expect((await servers().reserveNetworkPort(instance.id, [8100, 8101], options)).port).toBe(
      8101,
    );
  });

  // A full range evicts the stopped pair that ran least recently, never a running
  // one and never one with a live public link, and says so when nothing can go.
  it('evicts only idle pairs, oldest first, and fails when none can go', async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((name) => add(name)));
    const range = [8100, 8101];
    const none = { protect: new Set<string>(), externallyUsed: new Set<number>() };
    const ia = await servers().ensureInstance({
      serverId: a!.id,
      sessionId: 's1',
      sandboxPorts: [4100, 4101, 4102],
    });
    const ib = await servers().ensureInstance({
      serverId: b!.id,
      sessionId: 's1',
      sandboxPorts: [4100, 4101, 4102],
    });
    const ic = await servers().ensureInstance({
      serverId: c!.id,
      sessionId: 's1',
      sandboxPorts: [4100, 4101, 4102],
    });
    await servers().reserveNetworkPort(ia.id, range, none);
    await servers().reserveNetworkPort(ib.id, range, none);
    await servers().updateInstance(ia.id, { state: 'stopped', lastRanAt: new Date('2026-10-01') });
    await servers().updateInstance(ib.id, { state: 'stopped', lastRanAt: new Date('2026-10-02') });

    const protectedA = await servers()
      .reserveNetworkPort(ic.id, range, { protect: new Set([ia.id]), externallyUsed: new Set() })
      .then((result) => result);
    expect(protectedA.evictedInstanceId).toBe(ib.id);
    expect((await servers().getInstance(ib.id))?.networkPort).toBeNull();

    await servers().updateInstance(ia.id, { desired: 'running', state: 'running' });
    await servers().updateInstance(ic.id, { desired: 'running', state: 'starting' });
    await expect(servers().reserveNetworkPort(ib.id, range, none)).rejects.toBeInstanceOf(
      ManagedDevServerPortsFullError,
    );
  });

  it('drops instances with their session and their entry', async () => {
    const demo = await add('Demo');
    await servers().ensureInstance({
      serverId: demo.id,
      sessionId: 's1',
      sandboxPorts: [4100, 4101],
    });
    await servers().ensureInstance({
      serverId: demo.id,
      sessionId: 's2',
      sandboxPorts: [4100, 4101],
    });
    await ctx.store.deleteSession('s1');
    expect(await servers().listInstances({ serverId: demo.id })).toHaveLength(1);
    await servers().delete(demo.id);
    expect(await servers().listInstances({ projectId: 'p1' })).toHaveLength(0);
  });
});

it('protects a stopped pair with a live public link from eviction and publication failure', async () => {
  const entry = await add('Protected');
  const first = await servers().ensureInstance({
    serverId: entry.id,
    sessionId: 's1',
    sandboxPorts: [4100, 4101],
  });
  const second = await servers().ensureInstance({
    serverId: entry.id,
    sessionId: 's2',
    sandboxPorts: [4100, 4101],
  });
  const options = { protect: new Set<string>(), externallyUsed: new Set<number>() };
  await servers().reserveNetworkPort(first.id, [8100], options);
  const share = await ctx.store.createPublicPreviewShare({
    id: 'public-link',
    projectId: 'p1',
    devServerId: null,
    managedInstanceId: first.id,
    sessionId: 's1',
    containerGeneration: 'g1',
    targetPort: first.sandboxPort,
    publicOrigin: 'https://preview.example',
    edgeUrl: 'wss://preview.example/connector',
    pin: '123456',
    pinHash: 'hash',
    connectorToken: 'token',
    sessionSecret: 'secret',
    connectorContainerName: 'connector',
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect((await ctx.store.getPublicPreviewShare(share.id))?.managedInstanceId).toBe(first.id);
  await servers().releaseNetworkPort(first.id);
  expect((await servers().getInstance(first.id))?.networkPort).toBe(8100);
  await expect(servers().reserveNetworkPort(second.id, [8100], options)).rejects.toBeInstanceOf(
    ManagedDevServerPortsFullError,
  );
  await ctx.store.transitionPublicPreviewShare(share.id, ['creating'], 'revoked');
  expect((await servers().reserveNetworkPort(second.id, [8100], options)).evictedInstanceId).toBe(
    first.id,
  );
});
