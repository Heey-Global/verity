import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSecretCipher, isEncrypted } from './crypto.js';
import { EventStore, type LocalPreviewShareRecord } from './store.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;
let store: EventStore;
beforeAll(async () => {
  ctx = await createTestDb();
  store = new EventStore(ctx.db, createSecretCipher(Buffer.alloc(32, 0x11).toString('hex')));
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.db);
  await store.upsertProject({
    id: 'p1',
    owner: 'local',
    repo: 'preview',
    containerName: 'preview',
    state: 'active',
  });
  await store.createSession({
    sessionId: 's1',
    projectId: 'p1',
    worktree: '/wt/s1',
    model: 'test',
  });
});
const share = (
  patch: Partial<LocalPreviewShareRecord> = {},
): Omit<LocalPreviewShareRecord, 'state'> => ({
  id: 'local-1',
  projectId: 'p1',
  sessionId: 's1',
  managedInstanceId: null,
  networkPort: 42001,
  url: 'http://192.0.2.1:42001',
  targetPort: 3000,
  staticPath: null,
  connectorSecret: 'connector-secret',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  ...patch,
});

describe('durable local preview shares', () => {
  it('restores the binding and encrypted credentials from a new store instance', async () => {
    const input = share();
    await store.createLocalPreviewShare(input);
    const row = await ctx.db
      .selectFrom('local_preview_shares')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(isEncrypted(row.connector_secret)).toBe(true);
    expect(row.connector_secret).not.toContain(input.connectorSecret);
    const restarted = new EventStore(
      ctx.db,
      createSecretCipher(Buffer.alloc(32, 0x11).toString('hex')),
    );
    expect(await restarted.listLocalPreviewShares()).toEqual([{ ...input, state: 'active' }]);
    await restarted.revokeLocalPreviewShare(input.id);
    expect(await store.listLocalPreviewShares()).toEqual([{ ...input, state: 'revoking' }]);
  });
  it('reserves ports until resource cleanup completes', async () => {
    await store.createLocalPreviewShare(share());
    await store.revokeLocalPreviewShare('local-1');
    const replacement = share({ id: 'local-2', targetPort: 3001 });
    await expect(store.createLocalPreviewShare(replacement)).rejects.toThrow();
    await store.deleteLocalPreviewShare('local-1');
    await store.createLocalPreviewShare(replacement);
    expect(await store.listLocalPreviewShares()).toEqual([{ ...replacement, state: 'active' }]);
  });
  it('retargets an active listener while retaining its address and credentials', async () => {
    const input = share();
    await store.createLocalPreviewShare(input);
    await store.updateLocalPreviewShareTarget(input.id, 3001);
    expect(await store.listLocalPreviewShares()).toEqual([
      { ...input, targetPort: 3001, state: 'active' },
    ]);
    await store.revokeLocalPreviewShare(input.id);
    await store.updateLocalPreviewShareTarget(input.id, 3002);
    expect(await store.listLocalPreviewShares()).toEqual([
      { ...input, targetPort: 3001, state: 'revoking' },
    ]);
  });
  it('enforces one binding per target and exactly one target type', async () => {
    const input = share({ targetPort: null, staticPath: 'dist' });
    await store.createLocalPreviewShare(input);
    await expect(
      store.createLocalPreviewShare(share({ ...input, id: 'duplicate', networkPort: 42002 })),
    ).rejects.toThrow();
    await expect(
      store.createLocalPreviewShare(
        share({ id: 'invalid', networkPort: 42003, staticPath: 'public' }),
      ),
    ).rejects.toThrow();
    expect(await store.listLocalPreviewShares()).toEqual([{ ...input, state: 'active' }]);
  });
});
