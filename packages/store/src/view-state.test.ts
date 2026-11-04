import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
import { INBOX_DISMISSED_MAX, INBOX_KEY_MAX_CHARS } from './view-state.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.db
    .insertInto('users')
    .values([
      { id: 'view-a', role: 'member', status: 'active' },
      { id: 'view-b', role: 'member', status: 'active' },
    ])
    .execute();
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'owner-view',
    repo: 'repo',
    containerName: 'dev-owner-view-repo',
    state: 'active',
  });
  await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
});

const views = () => ctx.store.viewState;

describe('per-person view state', () => {
  // The whole point of the table: a shared value here means one member folding,
  // reading or dismissing changes what every other member sees.
  it('keeps folding separate per person', async () => {
    expect(await views().setProjectCollapsed('view-a', 'p1', true)).toBe(true);
    expect((await views().projectViews('view-a')).get('p1')?.collapsed).toBe(true);
    expect((await views().projectViews('view-b')).get('p1')).toBeUndefined();
    await views().setProjectCollapsed('view-a', 'p1', false);
    expect((await views().projectViews('view-a')).get('p1')?.collapsed).toBe(false);
    expect(await views().setProjectCollapsed('view-a', 'missing', true)).toBe(false);
  });

  it('keeps read marks separate per person and never moves one backward', async () => {
    expect(await views().setSessionSeen('view-a', 's1', 8)).toBe(8);
    // A stale poll must not bring back an unread dot that was already cleared.
    expect(await views().setSessionSeen('view-a', 's1', 3)).toBe(8);
    expect(await views().setSessionSeen('view-a', 's1', 20)).toBe(20);
    expect((await views().sessionView('view-b', 's1')).lastSeenEventCount).toBeNull();
    expect((await views().sessionViews('view-a')).get('s1')?.lastSeenEventCount).toBe(20);
    expect(await views().setSessionSeen('view-a', 'missing', 1)).toBeUndefined();
  });

  it('keeps dismissed Home items separate per person and restores them', async () => {
    const session = { kind: 'session', id: 's1' } as const;
    expect(await views().setInboxDismissed('view-a', session, 'question:s1:x', true)).toEqual([
      'question:s1:x',
    ]);
    expect((await views().sessionView('view-b', 's1')).inboxDismissed).toEqual([]);
    // Dismissing must not disturb the read mark stored in the same row.
    await views().setSessionSeen('view-a', 's1', 4);
    expect(await views().sessionView('view-a', 's1')).toEqual({
      lastSeenEventCount: 4,
      inboxDismissed: ['question:s1:x'],
    });
    expect(await views().setInboxDismissed('view-a', session, 'question:s1:x', false)).toEqual([]);
    const project = { kind: 'project', id: 'p1' } as const;
    await views().setInboxDismissed('view-a', project, 'health:p1:t', true);
    expect((await views().projectViews('view-a')).get('p1')).toEqual({
      collapsed: false,
      inboxDismissed: ['health:p1:t'],
    });
    expect(
      await views().setInboxDismissed('view-a', { kind: 'project', id: 'missing' }, 'k', true),
    ).toBeUndefined();
  });

  it('keeps both keys when two devices dismiss at once', async () => {
    const session = { kind: 'session', id: 's1' } as const;
    await Promise.all([
      views().setInboxDismissed('view-a', session, 'one', true),
      views().setInboxDismissed('view-a', session, 'two', true),
    ]);
    expect([...(await views().sessionView('view-a', 's1')).inboxDismissed].sort()).toEqual([
      'one',
      'two',
    ]);
  });

  it('bounds the dismissed list, dropping the oldest key, and rejects oversized keys', async () => {
    const session = { kind: 'session', id: 's1' } as const;
    for (let i = 0; i <= INBOX_DISMISSED_MAX; i++)
      await views().setInboxDismissed('view-a', session, `k${i}`, true);
    const list = (await views().sessionView('view-a', 's1')).inboxDismissed;
    expect(list).toHaveLength(INBOX_DISMISSED_MAX);
    expect(list[0]).toBe('k1');
    expect(list.at(-1)).toBe(`k${INBOX_DISMISSED_MAX}`);
    await expect(
      views().setInboxDismissed('view-a', session, 'x'.repeat(INBOX_KEY_MAX_CHARS + 1), true),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('disappears with its session, project or person', async () => {
    await views().setSessionSeen('view-a', 's1', 1);
    await views().setProjectCollapsed('view-b', 'p1', true);
    await ctx.db.deleteFrom('sessions').where('session_id', '=', 's1').execute();
    await ctx.db.deleteFrom('users').where('id', '=', 'view-b').execute();
    const rows = await ctx.db.selectFrom('user_view_state').selectAll().execute();
    expect(rows).toEqual([]);
  });

  it('gives every existing person the shared fold and read state on upgrade', async () => {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    try {
      expect((await migrator.migrateTo('0188_user_context')).error).toBeUndefined();
      await sql`update projects set collapsed = true where id = 'p1'`.execute(ctx.db);
      await sql`update sessions set last_seen_event_count = 5 where session_id = 's1'`.execute(
        ctx.db,
      );
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      for (const user of ['view-a', 'view-b', '00000000-0000-4000-8000-000000000001']) {
        expect((await views().projectViews(user)).get('p1')?.collapsed).toBe(true);
        expect((await views().sessionView(user, 's1')).lastSeenEventCount).toBe(5);
      }
    } finally {
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
    }
  });
});
