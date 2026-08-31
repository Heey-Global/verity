import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, truncateAll, type TestDb } from './testing.js';
import { DevServerPortRangeExhaustedError } from './store.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  // Dev servers are project-scoped (FK projects.id).
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-heey-global--verity',
    state: 'active',
  });
});

describe('EventStore — dev server CRUD', () => {
  it('creates, lists, gets, updates, and deletes dev servers', async () => {
    const a = await ctx.store.createDevServer({
      projectId: 'p1',
      name: 'Web',
      command: 'npm run dev',
    });
    const b = await ctx.store.createDevServer({
      projectId: 'p1',
      name: 'Docs',
      command: 'npm run docs',
      sortOrder: 1,
    });
    expect(a.id).toMatch(/[0-9a-f-]{36}/);
    expect(a.name).toBe('Web');
    expect(a.sourceKey).toBeNull();
    expect(a.autoStart).toBe(false);
    expect(a.sortOrder).toBe(0);

    // Ordered by sort_order, then created_at, then id.
    expect((await ctx.store.listDevServers('p1')).map((d) => d.name)).toEqual(['Web', 'Docs']);
    expect((await ctx.store.getDevServer(a.id))?.command).toBe('npm run dev');

    const updated = await ctx.store.updateDevServer(a.id, {
      command: 'pnpm dev',
      name: 'Frontend',
      autoStart: true,
    });
    expect(updated?.command).toBe('pnpm dev');
    expect(updated?.name).toBe('Frontend');
    expect(updated?.autoStart).toBe(true);
    // A partial patch leaves untouched fields alone.
    expect(updated?.url).toBeNull();

    expect(await ctx.store.deleteDevServer(b.id)).toBe(true);
    expect(await ctx.store.listDevServers('p1')).toHaveLength(1);
    expect(await ctx.store.deleteDevServer('does-not-exist')).toBe(false);
    expect(await ctx.store.updateDevServer('does-not-exist', { name: 'x' })).toBeUndefined();
  });

  it('defaults the name and trims blank fields to null', async () => {
    const d = await ctx.store.createDevServer({
      projectId: 'p1',
      command: '  npm run dev  ',
      url: '   ',
      hostPort: '3000',
    });
    expect(d.name).toBe('Dev server');
    expect(d.command).toBe('npm run dev');
    expect(d.url).toBeNull();
    expect(d.hostPort).toBe('3000');
  });
});

describe('EventStore — dev-server detection identity', () => {
  it('persists unique source keys and the latest detection fingerprint', async () => {
    const server = await ctx.store.createDevServer({
      projectId: 'p1',
      sourceKey: 'apps/web:dev',
      name: 'Web',
    });
    expect(server.sourceKey).toBe('apps/web:dev');
    await expect(
      ctx.store.createDevServer({ projectId: 'p1', sourceKey: 'apps/web:dev', name: 'Duplicate' }),
    ).rejects.toThrow();

    const state = await ctx.store.recordDevServerDetection('p1', 'first');
    expect(state).toMatchObject({
      projectId: 'p1',
      fingerprint: 'first',
      reviewedFingerprint: null,
      reviewedAt: null,
    });
    await ctx.store.recordDevServerDetection('p1', 'second');
    expect(await ctx.store.getDevServerDetectionState('p1')).toMatchObject({
      fingerprint: 'second',
      reviewedFingerprint: null,
    });
    expect(await ctx.store.reviewDevServerDetection('p1', 'first')).toBeUndefined();
    expect(await ctx.store.reviewDevServerDetection('p1', 'second')).toMatchObject({
      fingerprint: 'second',
      reviewedFingerprint: 'second',
      reviewedAt: expect.any(Date),
    });
  });
});

describe('EventStore — global dev-server host-port registry', () => {
  it('allocates globally across projects and reuses a released lease', async () => {
    await ctx.store.upsertProject({
      id: 'p2',
      owner: 'heey-global',
      repo: 'docs',
      containerName: 'verity-heey-global--docs',
      state: 'active',
    });
    const first = await ctx.store.createDevServer({ projectId: 'p1' });
    const second = await ctx.store.createDevServer({ projectId: 'p2' });
    expect(first.hostPort).toBe('3000');
    expect(second.hostPort).toBe('3001');
    await ctx.store.deleteDevServer(first.id);
    expect((await ctx.store.createDevServer({ projectId: 'p2' })).hostPort).toBe('3000');
  });

  it('releases project leases and assigns fresh leases on restore', async () => {
    await ctx.store.createDevServer({ projectId: 'p1' });
    await ctx.store.createDevServer({ projectId: 'p1' });
    await ctx.store.releaseProjectDevServerHostPorts('p1');
    expect((await ctx.store.listDevServers('p1')).map((server) => server.hostPort)).toEqual([
      null,
      null,
    ]);
    await ctx.store.reconcileDevServerHostPorts('p1');
    expect((await ctx.store.listDevServers('p1')).map((server) => server.hostPort)).toEqual([
      '3000',
      '3001',
    ]);
  });

  it('does not reacquire leases for a soft-deleted project during startup reconciliation', async () => {
    await ctx.store.createDevServer({ projectId: 'p1' });
    await ctx.store.hideProject('p1');
    await ctx.store.releaseProjectDevServerHostPorts('p1');

    await ctx.store.reconcileDevServerHostPorts();

    expect((await ctx.store.listDevServers('p1'))[0]?.hostPort).toBeNull();
  });

  it('continues in 8000-8099 and reports exhaustion after all 200 leases', async () => {
    const created = [];
    for (let index = 0; index < 200; index += 1) {
      created.push(await ctx.store.createDevServer({ projectId: 'p1', name: `Server ${index}` }));
    }
    expect(created[99]?.hostPort).toBe('3099');
    expect(created[100]?.hostPort).toBe('8000');
    expect(created[199]?.hostPort).toBe('8099');
    await expect(ctx.store.createDevServer({ projectId: 'p1' })).rejects.toBeInstanceOf(
      DevServerPortRangeExhaustedError,
    );
  });
});

describe('EventStore — dev-server ownership', () => {
  it('a project settings write leaves dev servers alone', async () => {
    await ctx.store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    await ctx.store.updateProjectSettings('p1', { memory: 'notes' });
    const list = await ctx.store.listDevServers('p1');
    expect(list).toHaveLength(1);
    expect(list[0]?.command).toBe('npm run dev');
  });

  it('cascades dev servers when the project is deleted', async () => {
    await ctx.store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    await ctx.store.deleteProject('p1');
    expect(await ctx.store.listDevServers('p1')).toHaveLength(0);
  });
});

describe('EventStore — dev-server session preview', () => {
  it('defaults to null, sets, and clears the preview session pointer', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/srv/clones/heey-global-verity/.verity-sessions/agent-s1',
      model: 'claude/default',
      projectId: 'p1',
    });
    const server = await ctx.store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    expect(server.previewSessionId).toBeNull();

    const previewing = await ctx.store.updateDevServer(server.id, { previewSessionId: 's1' });
    expect(previewing?.previewSessionId).toBe('s1');
    // A partial patch leaves the pointer alone.
    expect((await ctx.store.updateDevServer(server.id, { name: 'Web' }))?.previewSessionId).toBe(
      's1',
    );

    const reset = await ctx.store.updateDevServer(server.id, { previewSessionId: null });
    expect(reset?.previewSessionId).toBeNull();
  });

  it('resets to main when the previewed session is deleted', async () => {
    await ctx.store.createSession({
      sessionId: 's2',
      worktree: '/srv/clones/heey-global-verity/.verity-sessions/agent-s2',
      model: 'claude/default',
      projectId: 'p1',
    });
    const server = await ctx.store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    await ctx.store.updateDevServer(server.id, { previewSessionId: 's2' });

    await ctx.store.deleteSession('s2');

    expect((await ctx.store.getDevServer(server.id))?.previewSessionId).toBeNull();
  });
});
