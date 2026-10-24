import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretCipher } from './crypto.js';
import { createPostgresDb, migrateToLatest } from './db.js';
import { GoogleAccountStore } from './google-accounts.js';
import { EventStore } from './store.js';

const connectionString = process.env.VERITY_TEST_POSTGRES_URL;

describe.skipIf(connectionString === undefined)('Google image cleanup account removal race', () => {
  const db = createPostgresDb(connectionString ?? 'postgresql://localhost/verity');
  const cipher = createSecretCipher('ab'.repeat(32));
  const accounts = new GoogleAccountStore(db, cipher);
  const store = new EventStore(db, cipher);
  const sessionId = randomUUID();

  beforeAll(async () => {
    await migrateToLatest(db);
    await store.createSession({ sessionId, worktree: '/cleanup-race', model: 'test' });
  });
  afterAll(async () => {
    await db.deleteFrom('google_slide_image_cleanup').where('session_id', '=', sessionId).execute();
    await db.deleteFrom('sessions').where('session_id', '=', sessionId).execute();
    await db
      .deleteFrom('google_accounts')
      .where('email', '=', `${sessionId}@example.test`)
      .execute();
    await db.destroy();
  });

  it('retains credentials when cleanup insertion races account removal', async () => {
    const account = await accounts.save({
      email: `${sessionId}@example.test`,
      clientId: 'client',
      refreshToken: 'cleanup-secret',
      scopes: [],
    });
    const cleanupId = randomUUID();
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('google_accounts')
        .select('id')
        .where('id', '=', account.id)
        .forUpdate()
        .execute();
      locked();
      await gate;
    });
    const waitForWaiters = async (count: number) => {
      await expect
        .poll(async () => {
          const result = await sql<{ count: number }>`select count(*)::int as count
          from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
            db,
          );
          return result.rows[0]!.count;
        })
        .toBeGreaterThanOrEqual(count);
    };
    await ready;
    let insertion: Promise<unknown> | undefined;
    let removal: Promise<unknown> | undefined;
    try {
      insertion = store.createGoogleSlideImageCleanup({
        accountId: account.id,
        id: cleanupId,
        sessionId,
        fileId: cleanupId,
      });
      await waitForWaiters(1);
      // A removal that reads before locking can miss this queued cleanup insertion.
      removal = accounts.remove(account.id).then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForWaiters(2);
    } finally {
      release();
      await blocker;
    }
    await insertion;
    expect(await removal).toMatchObject({ message: expect.stringContaining('cleanup') });
    expect((await accounts.credentials(account.id))?.refreshToken).toBe('cleanup-secret');
    await store.completeGoogleSlideImageCleanup(cleanupId);
    await accounts.remove(account.id);
  });
});
