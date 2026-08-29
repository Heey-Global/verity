import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
    connectorToken: 'connector-secret',
    sessionSecret: 'session-secret',
    connectorContainerName: `verity-preview-${suffix}`,
    expiresAt,
  });
};

describe('EventStore — public preview shares', () => {
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
