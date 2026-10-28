import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './testing.js';
describe('backup project bookkeeping and atomic revocations', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => {
    await ctx.close();
  });
  it('keeps Git identity in project state independently of sandbox files', async () => {
    await sql`insert into projects(id,owner,repo,container_name,state,kind) values ('backup-p','test','repo','backup-container','absent','local')`.execute(
      ctx.db,
    );
    const first = await ctx.store.backupGitRepositoryKey('backup-p', 'workspaces/repo/.git');
    expect(await ctx.store.backupGitRepositoryKey('backup-p', 'workspaces/repo/.git')).toBe(first);
    expect(
      await ctx.store.backupGitRepositoryKey('backup-p', 'workspaces/repo/nested/.git'),
    ).not.toBe(first);
    await expect(ctx.store.backupGitRepositoryKey('backup-p', '../outside')).rejects.toThrow();
  });
  it('retains server-owned identities for Git data without a live project', async () => {
    const path = 'workspaces/deleted-project/.git';
    const keys = await Promise.all(
      Array.from({ length: 4 }, () => ctx.store.backupGitRepositoryKey(null, path)),
    );
    expect(new Set(keys).size).toBe(1);
    expect(await ctx.store.backupGitRepositoryKey(null, 'sessions/orphan/.git')).not.toBe(keys[0]);
    await expect(ctx.store.backupGitRepositoryKey(null, '../outside')).rejects.toThrow();
  });
  it('leaves journaling off before setup, and queues single and bulk revocations in the deletion transaction', async () => {
    await ctx.store.insertAuthToken({ id: 'before-setup', tokenHash: 'hash-before' });
    await ctx.store.deleteAuthToken('before-setup');
    expect(await ctx.store.listBackupRevocations()).toEqual([]);
    await ctx.store.setBackupJournaling(true);
    await ctx.store.insertAuthToken({ id: 'single', tokenHash: 'hash-single' });
    await ctx.store.deleteAuthToken('single');
    expect(await ctx.store.deleteAuthToken('single')).toBe(false);
    await ctx.store.insertAuthToken({ id: 'bulk-a', tokenHash: 'hash-a' });
    await ctx.store.insertAuthToken({ id: 'bulk-b', tokenHash: 'hash-b' });
    await ctx.store.deleteAllAuthTokens();
    const outbox = await ctx.store.listBackupRevocations();
    expect(outbox.map((event) => event.deviceId).sort()).toEqual(['bulk-a', 'bulk-b', 'single']);
    for (const event of outbox) await ctx.store.acknowledgeBackupRevocation(event.id);
    expect(await ctx.store.listBackupRevocations()).toEqual([]);
    await ctx.store.setBackupJournaling(false);
    await ctx.store.insertAuthToken({ id: 'new-identity-cleanup', tokenHash: 'hash-new' });
    await ctx.store.deleteAllAuthTokens();
    expect(await ctx.store.listBackupRevocations()).toEqual([]);
  });
  it('notifies only after committed deletion and retains the outbox when the destination fails', async () => {
    await ctx.store.setBackupJournaling(true);
    await ctx.store.insertAuthToken({ id: 'notify-after-commit', tokenHash: 'notify-hash' });
    let observedDeleted = false;
    let observedQueued = false;
    const listener = vi.fn(async () => {
      observedDeleted = !(await ctx.store.listAuthTokens()).some(
        (token) => token.id === 'notify-after-commit',
      );
      observedQueued = (await ctx.store.listBackupRevocations()).some(
        (event) => event.deviceId === 'notify-after-commit',
      );
      throw new Error('Destination offline');
    });
    const unsubscribe = ctx.store.subscribeBackupRevocations(listener);
    try {
      expect(await ctx.store.deleteAuthToken('notify-after-commit')).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
      expect(observedDeleted).toBe(true);
      expect(observedQueued).toBe(true);
      expect(await ctx.store.deleteAuthToken('notify-after-commit')).toBe(false);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
    for (const event of await ctx.store.listBackupRevocations())
      await ctx.store.acknowledgeBackupRevocation(event.id);
  });
  it('does not delete a token if its durable outbox write fails', async () => {
    await ctx.store.setBackupJournaling(true);
    await ctx.store.insertAuthToken({ id: 'atomic', tokenHash: 'hash-atomic' });
    await sql`alter table backup_revocation_outbox add constraint reject_fixture check (device_id <> 'atomic')`.execute(
      ctx.db,
    );
    try {
      await expect(ctx.store.deleteAuthToken('atomic')).rejects.toThrow();
      expect((await ctx.store.listAuthTokens()).some((token) => token.id === 'atomic')).toBe(true);
    } finally {
      await sql`alter table backup_revocation_outbox drop constraint reject_fixture`.execute(
        ctx.db,
      );
    }
  });
});
