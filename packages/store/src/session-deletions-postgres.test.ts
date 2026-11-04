import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { createPostgresDb, migrateToLatest } from './db.js';
import { EventStore } from './store.js';

const connectionString = process.env.VERITY_TEST_POSTGRES_URL;
const describePostgres = connectionString === undefined ? describe.skip : describe;

describePostgres('session deletion across independent Server pools', () => {
  it('rechecks deletion admission after an append waits for the event lock', async () => {
    const dbA = createPostgresDb(connectionString!);
    const dbB = createPostgresDb(connectionString!);
    const store = new EventStore(dbB);
    const id = randomUUID();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let blocker: Promise<void> | undefined;
    let append: Promise<unknown> | undefined;
    try {
      await migrateToLatest(dbA);
      await store.createSession({ sessionId: id, worktree: `/wt/${id}`, model: 'test' });
      blocker = dbA.transaction().execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${'events:' + id}))`.execute(tx);
        entered();
        await gate;
        await tx
          .insertInto('session_deletions')
          .values({ session_id: id, payload: '{}', cleanup_pending: true, worktree: null })
          .execute();
      });
      await ready;
      append = store.appendEvent(id, { t: 'text', delta: 'late' });
      const rejected = expect(append).rejects.toThrow();
      await expect
        .poll(async () => {
          const result = await sql<{
            n: number;
          }>`select count(*)::int as n from pg_locks where locktype='advisory' and not granted`.execute(
            dbA,
          );
          return result.rows[0]!.n;
        })
        .toBeGreaterThan(0);
      release();
      await blocker;
      await rejected;
      expect(
        await dbB.selectFrom('events').select('id').where('session_id', '=', id).execute(),
      ).toEqual([]);
    } finally {
      release();
      await Promise.allSettled([blocker, append]);
      await store.deleteSession(id);
      await dbA.deleteFrom('session_deletions').where('session_id', '=', id).execute();
      await Promise.all([dbA.destroy(), dbB.destroy()]);
    }
  });

  it('keeps cleanup exclusive and reserves the worktree until physical removal completes', async () => {
    const dbA = createPostgresDb(connectionString!);
    const dbB = createPostgresDb(connectionString!);
    const a = new EventStore(dbA);
    const b = new EventStore(dbB);
    const id = randomUUID();
    const successor = randomUUID();
    const worktree = `/wt/delete-${id}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    let creation: Promise<void> | undefined;
    try {
      await migrateToLatest(dbA);
      await a.createSession({ sessionId: id, worktree, model: 'test' });
      await a.queueSessionDeletion(
        id,
        JSON.stringify({
          session: { sessionId: id, worktree, projectId: null, model: 'test' },
          previewIds: [],
        }),
      );
      await a.deleteSession(id);
      first = a.withSessionDeletionCleanup(id, async () => {
        // The cleanup lease must permit its callback's ordinary store reads.
        expect(await a.isWorktreeBeingDeleted(worktree)).toBe(true);
        entered();
        await gate;
        return true;
      });
      await ready;
      const duplicate = vi.fn(async () => true);
      second = b.withSessionDeletionCleanup(id, duplicate);
      const created = vi.fn();
      creation = b.createSession({ sessionId: successor, worktree, model: 'test' }).then(() => {
        created();
      });
      // These pools have no shared JS mutex: only the DB locks preserve ownership.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(duplicate).not.toHaveBeenCalled();
      expect(created).not.toHaveBeenCalled();
      release();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      await creation;
      expect(duplicate).not.toHaveBeenCalled();
      expect(await b.getSession(successor)).toBeDefined();
      expect(await b.isSessionDeleting(id)).toBe(true);
    } finally {
      release();
      await Promise.allSettled([first, second, creation]);
      await b.deleteSession(successor);
      await a.deleteSession(id);
      await dbA.deleteFrom('session_deletions').where('session_id', '=', id).execute();
      await Promise.all([dbA.destroy(), dbB.destroy()]);
    }
  });
});
