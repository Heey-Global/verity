import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { EventStore, RUNNER_FRAME_PROTOCOL_VERSION } from './store.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession({ sessionId: 'a', worktree: '/wt/a', model: 'm' });
  await ctx.store.createSession({ sessionId: 'b', worktree: '/wt/b', model: 'm' });
});

async function expectCanonicalStats(id: string): Promise<void> {
  const rows = await ctx.db
    .selectFrom('events')
    .select(['id', 'created_at', 'type'])
    .where('session_id', '=', id)
    .orderBy('id', 'desc')
    .execute();
  const marker = await ctx.store.getSessionEventStats(id);
  expect(marker).toMatchObject({
    eventCount: rows.filter((row) => row.type !== 'dev_servers_changed').length,
    lastEventSeq: Number(rows[0]?.id ?? 0),
    lastActivityAt: rows[0]?.created_at.getTime() ?? null,
  });
  const facts = (await ctx.store.listSessionProjectionFacts([id], 5)).get(id);
  expect(facts).toMatchObject({
    eventCount: rows.filter((row) => row.type !== 'dev_servers_changed').length,
    lastEventSeq: Number(rows[0]?.id ?? 0),
    lastActivityAt: rows[0]?.created_at.getTime() ?? null,
  });
}

async function insertRaw(id: number, sessionId = 'a', at = '2026-01-01T00:00:00Z'): Promise<void> {
  await sql`insert into events (id, session_id, type, payload, created_at)
    values (${id}, ${sessionId}, 'text', ${JSON.stringify({ t: 'text', delta: 'x' })}::jsonb, ${at}::timestamptz)`.execute(
    ctx.db,
  );
}

describe('durable session event statistics', () => {
  it('restores the latest listener snapshot across unrelated message events', async () => {
    expect(await ctx.store.getLatestDevServersEvent('a')).toBeUndefined();
    const listeners = [
      { port: 5173, reachable: true, pid: 1, name: 'vite', command: 'vite', workdir: '/work/a' },
    ];
    await ctx.store.appendEvent('a', { t: 'dev_servers_changed', devServers: listeners });
    expect((await ctx.store.getLatestDevServersEvent('a'))?.devServers).toEqual(listeners);
    await ctx.store.appendEvent('a', { t: 'dev_servers_changed', devServers: [] });
    await ctx.store.setSessionSeen('a', (await ctx.store.getSessionEventStats('a'))!.eventCount);
    await ctx.store.appendEvent('a', { t: 'text', delta: 'new message' });
    expect(await ctx.store.getLatestDevServersEvent('a')).toEqual({
      t: 'dev_servers_changed',
      devServers: [],
    });
    expect(await ctx.store.getLatestDevServersEvent('b')).toBeUndefined();
    expect((await ctx.store.getSessionEventStats('a'))!.eventCount).toBeGreaterThan(
      (await ctx.store.getSession('a'))!.lastSeenEventCount!,
    );
  });

  it('keeps listener lifecycle changes out of unread counts without losing snapshots', async () => {
    await ctx.store.appendEvent('a', { t: 'text', delta: 'read message' });
    await ctx.store.setSessionSeen('a', 1);
    const before = (await ctx.store.getSessionEventStats('a'))!;
    const listener = {
      port: 5173,
      reachable: true,
      pid: 1,
      name: 'vite',
      command: 'vite',
      workdir: '/work/a',
    };
    for (const devServers of [[listener], [], [{ ...listener, pid: 99 }]]) {
      await ctx.store.appendEvent('a', { t: 'dev_servers_changed', devServers });
      await expectCanonicalStats('a');
      expect((await ctx.store.getSessionEventStats('a'))!.eventCount).toBe(1);
      expect((await ctx.store.getSession('a'))!.lastSeenEventCount).toBe(1);
      expect((await ctx.store.getLatestDevServersEvent('a'))!.devServers).toEqual(devServers);
    }
    expect((await ctx.store.getSessionEventStats('a'))!.lastEventSeq).toBeGreaterThan(
      before.lastEventSeq,
    );
    await ctx.store.appendEvent('a', { t: 'text', delta: 'unread message' });
    await ctx.store.appendEvent('a', { t: 'dev_servers_changed', devServers: [] });
    expect((await ctx.store.getSessionEventStats('a'))!.eventCount).toBe(2);
    expect((await ctx.store.getSession('a'))!.lastSeenEventCount).toBe(1);
  });

  it('maintains filtered counts on listener edits, moves and deletion', async () => {
    const event = await ctx.store.appendEvent('a', { t: 'dev_servers_changed', devServers: [] });
    await expectCanonicalStats('a');
    await sql`update events set type = 'text', payload = '{"t":"text","delta":"visible"}'::jsonb
      where id = ${event.seq}`.execute(ctx.db);
    await expectCanonicalStats('a');
    await sql`update events set type = 'dev_servers_changed',
      payload = '{"t":"dev_servers_changed","devServers":[]}'::jsonb,
      session_id = 'b' where id = ${event.seq}`.execute(ctx.db);
    await expectCanonicalStats('a');
    await expectCanonicalStats('b');
    await ctx.db.deleteFrom('events').where('id', '=', event.seq).execute();
    await expectCanonicalStats('b');
  });

  it('translates historical read marks without clearing unread messages', async () => {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    try {
      expect(
        (await migrator.migrateTo('0132_unique_brokered_prompt_v2_grants')).error,
      ).toBeUndefined();
      for (const id of ['a', 'b']) {
        await ctx.store.appendEvent(id, { t: 'dev_servers_changed', devServers: [] });
        await ctx.store.appendEvent(id, { t: 'text', delta: 'read' });
        if (id === 'a') await ctx.store.setSessionSeen(id, 2);
        await ctx.store.appendEvent(id, { t: 'dev_servers_changed', devServers: [] });
        await ctx.store.appendEvent(id, { t: 'text', delta: 'unread' });
        await ctx.store.appendEvent(id, { t: 'dev_servers_changed', devServers: [] });
      }
      await ctx.store.createSession({ sessionId: 'c', worktree: '/wt/c', model: 'm' });
      await ctx.store.appendEvent('c', { t: 'text', delta: 'already read' });
      await ctx.store.appendEvent('c', { t: 'dev_servers_changed', devServers: [] });
      await ctx.store.setSessionSeen('c', 2);
      await ctx.store.appendEvent('c', { t: 'dev_servers_changed', devServers: [] });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      expect((await ctx.store.getSession('c'))!.lastSeenEventCount).toBe(1);
      expect((await ctx.store.getSessionEventStats('c'))!.eventCount).toBe(1);
      expect((await ctx.store.getSession('a'))!.lastSeenEventCount).toBe(1);
      expect((await ctx.store.getSession('b'))!.lastSeenEventCount).toBeNull();
      await expectCanonicalStats('a');
      expect((await ctx.store.getSessionEventStats('a'))!.eventCount).toBe(2);
      expect(
        (await migrator.migrateTo('0132_unique_brokered_prompt_v2_grants')).error,
      ).toBeUndefined();
      expect((await ctx.store.getSession('a'))!.lastSeenEventCount).toBe(2);
      expect((await ctx.store.getSessionEventStats('a'))!.eventCount).toBe(5);
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      expect((await ctx.store.getSession('a'))!.lastSeenEventCount).toBe(1);
    } finally {
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
    }
  });

  it('keeps never-written sessions empty and removes markers on session deletion', async () => {
    expect(await ctx.store.getSessionEventStats('a')).toBeUndefined();
    expect(
      (await ctx.store.listSessionProjectionFacts(['a', 'missing'], 5)).get('a'),
    ).toMatchObject({ eventCount: 0, lastEventSeq: 0, lastActivityAt: null });
    await ctx.store.appendEvent('a', { t: 'text', delta: 'live' });
    await expectCanonicalStats('a');
    await ctx.store.deleteSession('a');
    expect(await ctx.store.getSessionEventStats('a')).toBeUndefined();
    await ctx.store.createSession({ sessionId: 'a', worktree: '/wt/a', model: 'm' });
    expect(await ctx.store.getSessionEventStats('a')).toBeUndefined();
  });

  it('tracks every append path and provisional fence removal without counting duplicate frames', async () => {
    const prompt = await ctx.store.appendEvent('a', { t: 'prompt', text: 'go' });
    await ctx.store.markTurnRunning({ sessionId: 'a', promptSeq: prompt.seq });
    await ctx.store.bindTurnIdentity('a', { turnId: 'turn', startCommandId: 'start' });
    await expectCanonicalStats('a');
    const conditional = await ctx.store.appendEventForRunningTurn(
      'a',
      {
        promptSeq: prompt.seq,
        turnId: 'turn',
        silentSinceSeq: prompt.seq,
      },
      { t: 'notice', role: 'agent', text: 'conditional' },
    );
    expect(conditional).not.toBeNull();
    await expectCanonicalStats('a');
    const frame = {
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      runnerInstanceId: 'runner',
      turnId: 'turn',
      frameSeq: 1,
      payloadHash: 'hash',
      event: { t: 'text' as const, delta: 'runner' },
    };
    expect((await ctx.store.ingestRunnerFrame('a', frame)).outcome).toBe('accepted');
    await expectCanonicalStats('a');
    const claimed = await ctx.store.getSessionEventStats('a');
    expect((await ctx.store.ingestRunnerFrame('a', frame)).outcome).toBe('duplicate');
    expect(await ctx.store.getSessionEventStats('a')).toEqual(claimed);
    const anchor = (await ctx.store.listRunningTurns())[0]!;
    const fenced = await ctx.store.fenceRunningTurnIfSilent(anchor, claimed!.lastEventSeq, {
      t: 'notice',
      role: 'agent',
      text: 'provisional',
    });
    expect(fenced).not.toBeNull();
    await expectCanonicalStats('a');
    await ctx.store.releaseRunningTurnFence(anchor, fenced!.noticeSeq, fenced!.fenceSeq);
    await expectCanonicalStats('a');
    expect((await ctx.store.getSessionEventStats('a'))?.eventCount).toBe(claimed!.eventCount);
    expect((await ctx.store.getSessionEventStats('a'))?.revision).not.toBe(claimed!.revision);
    await ctx.store.enqueueTurn({ id: 'queued', sessionId: 'a', prompt: 'queued', opts: {} });
    expect(
      await ctx.store.drainQueuedTurn('queued', 'a', { t: 'prompt', text: 'queued' }),
    ).toBeDefined();
    await expectCanonicalStats('a');
    const drained = await ctx.store.getSessionEventStats('a');
    expect(
      await ctx.store.drainQueuedTurn('queued', 'a', { t: 'prompt', text: 'queued' }),
    ).toBeUndefined();
    expect(await ctx.store.getSessionEventStats('a')).toEqual(drained);
  });

  it('counts late lower sequences and tracks seq order rather than timestamp order', async () => {
    await insertRaw(100, 'a', '2026-01-01T00:00:00Z');
    const before = await ctx.store.getSessionEventStats('a');
    await insertRaw(50, 'a', '2026-02-01T00:00:00Z');
    await expectCanonicalStats('a');
    expect((await ctx.store.getSessionEventStats('a'))?.revision).not.toBe(before?.revision);
    expect((await ctx.store.getSessionEventStats('a'))?.lastEventSeq).toBe(before?.lastEventSeq);
    // Global event sequences have gaps; using the maximum as a count silently inflates unread badges.
    expect((await ctx.store.getSessionEventStats('a'))?.eventCount).toBe(2);
  });

  it('updates revisions on interior deletion, replaces a deleted head, and retains an empty marker', async () => {
    await insertRaw(10);
    await insertRaw(20);
    await insertRaw(30);
    const before = await ctx.store.getSessionEventStats('a');
    await ctx.db.deleteFrom('events').where('id', '=', 20).execute();
    await expectCanonicalStats('a');
    const interior = await ctx.store.getSessionEventStats('a');
    expect(interior?.lastEventSeq).toBe(before?.lastEventSeq);
    expect(interior?.revision).not.toBe(before?.revision);
    await ctx.db.deleteFrom('events').where('id', '=', 30).execute();
    await expectCanonicalStats('a');
    await ctx.db.deleteFrom('events').where('session_id', '=', 'a').execute();
    await expectCanonicalStats('a');
  });

  it('tracks direct payload edits, session moves, and changed head identity/time', async () => {
    await insertRaw(10);
    const before = await ctx.store.getSessionEventStats('a');
    await sql`update events set payload = '{"t":"text","delta":"edited"}'::jsonb where id = 10`.execute(
      ctx.db,
    );
    await expectCanonicalStats('a');
    expect((await ctx.store.getSessionEventStats('a'))?.revision).not.toBe(before?.revision);
    await sql`update events set id = 20, created_at = '2026-03-01'::timestamptz where id = 10`.execute(
      ctx.db,
    );
    await expectCanonicalStats('a');
    await ctx.db.updateTable('events').set({ session_id: 'b' }).where('id', '=', 20).execute();
    await expectCanonicalStats('a');
    await expectCanonicalStats('b');
  });

  it('rolls counter changes back with their event transaction', async () => {
    await insertRaw(10);
    const before = await ctx.store.getSessionEventStats('a');
    await expect(
      ctx.db.transaction().execute(async (tx) => {
        await tx.deleteFrom('events').where('id', '=', 10).execute();
        await sql`insert into events (session_id, type, payload) values ('a', 'text', '{"t":"text","delta":"rollback"}'::jsonb)`.execute(
          tx,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await ctx.store.getSessionEventStats('a')).toEqual(before);
    await expectCanonicalStats('a');
  });

  it('backfills existing logs and safely removes/reinstalls the projection on migration rollback', async () => {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    const migrations = Object.keys(await migrationProvider.getMigrations()).sort();
    const previous = migrations[migrations.indexOf('0125_session_event_stats') - 1]!;
    try {
      expect((await migrator.migrateTo(previous)).error).toBeUndefined();
      await insertRaw(50);
      await insertRaw(10, 'a', '2026-02-01T00:00:00Z');
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      await expectCanonicalStats('a');
      expect(await ctx.store.getSessionEventStats('b')).toBeUndefined();
      await ctx.store.appendEvent('a', { t: 'text', delta: 'after migration' });
      await expectCanonicalStats('a');
    } finally {
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
    }
  });

  it('reads overview counters without counting every streamed event', async () => {
    await ctx.store.appendEvent('a', { t: 'text', delta: 'history' });
    const queries: { sql: string; parameters: readonly unknown[] }[] = [];
    const observed = ctx.db.withPlugin({
      transformQuery(args) {
        queries.push(ctx.db.getExecutor().compileQuery(args.node, args.queryId));
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    await new EventStore(observed).listSessionProjectionFacts(['a'], 5);
    // An exact unread count must stay a row lookup as streaming text grows.
    // Counting completed result rows for usage is a different, bounded-kind read.
    for (const query of queries.filter(
      (q) => /count\s*\(/i.test(q.sql) && /\bevents\b/.test(q.sql),
    )) {
      const typeBinding = query.sql.match(/"type"\s*=\s*\$(\d+)/);
      expect(typeBinding, query.sql).not.toBeNull();
      expect(query.parameters[Number(typeBinding![1]) - 1]).toBe('result');
    }
    expect(queries.some((query) => query.sql.includes('"session_event_stats"'))).toBe(true);
  });
});
