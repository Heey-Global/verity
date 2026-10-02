import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    containerName: 'verity-heey-global--verity',
    state: 'active',
  });
});

const create = async (suffix = '1', expiresAt = new Date('2030-01-01T00:00:00Z')) => {
  const devServer = await ctx.store.createDevServer({
    projectId: 'p1',
    name: 'Web',
    containerPort: '3000',
  });
  return ctx.store.createPublicPreviewShare({
    id: `share-${suffix}`,
    projectId: 'p1',
    devServerId: devServer.id,
    containerGeneration: 'generation-1',
    targetPort: 3000,
    publicOrigin: `https://share-${suffix}.preview.example`,
    edgeUrl: `wss://share-${suffix}.preview.example/__verity/connector`,
    pinHash: 'scrypt:salt:hash',
    pin: '123456',
    connectorToken: 'connector-secret',
    sessionSecret: 'session-secret',
    connectorContainerName: `verity-preview-${suffix}`,
    expiresAt,
  });
};

describe('EventStore — public preview shares', () => {
  it('retains a lock event that precedes share persistence', async () => {
    await ctx.store.lockPublicPreviewSharePin('share-early');
    const share = await create('early');
    expect(share.pinLocked).toBe(true);
    expect(share.state).toBe('creating');
    expect(await ctx.db.selectFrom('public_preview_pin_locks').selectAll().execute()).toEqual([]);
  });

  // A lock's zero-row update can finish before create consumes its snapshot.
  it('keeps the PIN locked when creation overtakes an in-flight lock event', async () => {
    let finishQuery!: () => void;
    const queryFinished = new Promise<void>((resolve) => {
      finishQuery = resolve;
    });
    let resume!: () => void;
    const resumeEvent = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const executor = ctx.db.getExecutor();
    const executeQuery = executor.executeQuery.bind(executor);
    let paused = false;
    const spy = vi.spyOn(executor, 'executeQuery').mockImplementation(async (...args) => {
      const result = await executeQuery(...args);
      const compiled = args[0];
      if (
        !paused &&
        compiled.sql.startsWith('update "public_preview_shares"') &&
        compiled.sql.includes('returning "id"') &&
        compiled.parameters.includes('share-racing')
      ) {
        paused = true;
        expect(result.rows).toEqual([]);
        finishQuery();
        await resumeEvent;
      }
      return result;
    });
    const lock = ctx.store.lockPublicPreviewSharePin('share-racing');
    try {
      await queryFinished;
      const share = await create('racing');
      expect(share.pinLocked).toBe(true);
      await ctx.store.transitionPublicPreviewShare(share.id, ['creating'], 'active');
      resume();
      await lock;
      expect(await ctx.store.getPublicPreviewShare(share.id)).toMatchObject({
        pinLocked: true,
        state: 'active',
        revokedAt: null,
      });
      expect(await ctx.store.listPublicPreviewShares('p1')).toMatchObject([
        { id: share.id, pinLocked: true, state: 'active' },
      ]);
    } finally {
      resume();
      await lock;
      spy.mockRestore();
    }
  });

  it('cleans snapshots too old to belong to a live preview', async () => {
    await ctx.db
      .insertInto('public_preview_pin_locks')
      .values({
        share_id: 'abandoned',
        created_at: '2000-01-01T00:00:00Z',
      })
      .execute();
    await ctx.store.lockPublicPreviewSharePin('new-snapshot');
    expect(
      await ctx.db.selectFrom('public_preview_pin_locks').select('share_id').execute(),
    ).toEqual([{ share_id: 'new-snapshot' }]);
  });

  // A lock snapshot must survive reload without revoking access for existing cookies.
  it('persists an idempotent PIN lock separately from the share lifecycle', async () => {
    const share = await create();
    expect(share.pinLocked).toBe(false);
    await ctx.store.transitionPublicPreviewShare(share.id, ['creating'], 'active');
    await ctx.store.lockPublicPreviewSharePin(share.id);
    await ctx.store.lockPublicPreviewSharePin(share.id);
    expect(await ctx.store.getPublicPreviewShare(share.id)).toMatchObject({
      pinLocked: true,
      state: 'active',
      revokedAt: null,
    });
    expect(await ctx.store.listPublicPreviewShares('p1')).toMatchObject([{ pinLocked: true }]);
    await expect(ctx.store.lockPublicPreviewSharePin('unknown-share')).resolves.toBeUndefined();
  });

  it('persists the session source of a static share for recovery', async () => {
    const share = await ctx.store.createPublicPreviewShare({
      id: 'session-static',
      projectId: 'p1',
      devServerId: null,
      containerGeneration: 'generation-1',
      targetPort: null,
      targetKind: 'static-folder',
      staticPath: 'dist',
      sessionId: 'session-1',
      publicOrigin: 'https://static.preview.example',
      edgeUrl: 'wss://static.preview.example/__verity/connector',
      pinHash: 'scrypt:salt:hash',
      pin: '123456',
      connectorToken: 'connector-secret',
      sessionSecret: 'session-secret',
      connectorContainerName: 'verity-preview-session-static',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    expect(share.sessionId).toBe('session-1');
    expect((await ctx.store.getPublicPreviewShare(share.id))?.sessionId).toBe('session-1');
  });
  it('keeps the PIN so every device can show it again', async () => {
    const devServer = await ctx.store.createDevServer({
      projectId: 'p1',
      name: 'Web',
      containerPort: '3000',
    });
    const share = await ctx.store.createPublicPreviewShare({
      id: 'with-pin',
      projectId: 'p1',
      devServerId: devServer.id,
      containerGeneration: 'generation-1',
      targetPort: 3000,
      publicOrigin: 'https://with-pin.preview.example',
      edgeUrl: 'wss://with-pin.preview.example/__verity/connector',
      pinHash: 'scrypt:salt:hash',
      pin: '482913',
      connectorToken: 'connector-secret',
      sessionSecret: 'session-secret',
      connectorContainerName: 'verity-preview-with-pin',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    expect(share.pin).toBe('482913');
    expect((await ctx.store.listPublicPreviewShares('p1'))[0]?.pin).toBe('482913');
  });

  it('durably records idempotent pending Uplink removals', async () => {
    await ctx.store.addPendingUplinkShareRemoval('orphan-1');
    await ctx.store.addPendingUplinkShareRemoval('orphan-1');
    expect(await ctx.store.listPendingUplinkShareRemovals()).toEqual(['orphan-1']);
    await ctx.store.deletePendingUplinkShareRemoval('orphan-1');
    expect(await ctx.store.listPendingUplinkShareRemovals()).toEqual([]);
  });

  it('persists secret-bearing lifecycle state and exposes CAS transitions', async () => {
    const share = await create();
    expect(share).toMatchObject({
      state: 'creating',
      connectorToken: 'connector-secret',
      sessionSecret: 'session-secret',
    });

    const active = await ctx.store.transitionPublicPreviewShare(share.id, ['creating'], 'active', {
      connectorContainerId: 'connector-1',
    });
    expect(active).toMatchObject({ state: 'active', connectorContainerId: 'connector-1' });
    await expect(
      ctx.store.transitionPublicPreviewShare(share.id, ['creating'], 'failed'),
    ).resolves.toBeUndefined();
  });

  it('enforces one live share per dev server and releases it after revocation', async () => {
    const first = await create();
    const devServerId = first.devServerId;
    await expect(
      ctx.store.createPublicPreviewShare({
        id: 'share-2',
        projectId: 'p1',
        devServerId,
        containerGeneration: 'generation-1',
        targetPort: 3000,
        publicOrigin: 'https://share-2.preview.example',
        edgeUrl: 'wss://share-2.preview.example/__verity/connector',
        pinHash: 'pin',
        pin: '123456',
        connectorToken: 'connector',
        sessionSecret: 'session',
        connectorContainerName: 'verity-preview-2',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      }),
    ).rejects.toThrow();
    await ctx.store.transitionPublicPreviewShare(first.id, ['creating'], 'revoked', {
      revokedAt: new Date(),
    });
    await expect(
      ctx.store.createPublicPreviewShare({
        id: 'share-3',
        projectId: 'p1',
        devServerId,
        containerGeneration: 'generation-1',
        targetPort: 3000,
        publicOrigin: 'https://share-3.preview.example',
        edgeUrl: 'wss://share-3.preview.example/__verity/connector',
        pinHash: 'pin',
        pin: '123456',
        connectorToken: 'connector',
        sessionSecret: 'session',
        connectorContainerName: 'verity-preview-3',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      }),
    ).resolves.toMatchObject({ id: 'share-3' });
  });

  it('finds only nonterminal shares whose TTL is due', async () => {
    const due = await create('due', new Date('2026-01-01T00:00:00Z'));
    expect(
      (await ctx.store.listPublicPreviewSharesDue(new Date('2026-01-02T00:00:00Z'))).map(
        ({ id }) => id,
      ),
    ).toEqual([due.id]);
  });
});
