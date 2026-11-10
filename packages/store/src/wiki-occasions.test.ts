// What a project's Wiki may need to reflect. The failures worth guarding are
// silent: a merge recorded again after every restart, a deleted session's
// messages kept after the run read them, a growing chat day never read again.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
import { WIKI_OCCASION_BODY_LIMIT } from './wiki-occasions.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createProject({
    id: 'p',
    owner: 'team',
    repo: 'p',
    containerName: 'p',
    state: 'active',
  });
});

it('records an occasion once and does not bring a read one back', async () => {
  const occasions = ctx.store.wikiOccasions;
  const merge = { projectId: 'p', kind: 'merge' as const, ref: 'pr/1', title: 'Merged #1' };
  expect(await occasions.record(merge)).toBe(true);
  expect(await occasions.record(merge)).toBe(false);
  const [open] = await occasions.open('p');
  expect(await occasions.close('p', [open!])).toBe(1);
  // The status cache refills after a restart and reports the merge again.
  expect(await occasions.record(merge)).toBe(false);
  expect(await occasions.countOpen('p')).toBe(0);
});

it('opens a growing chat day again and drops kept text once read', async () => {
  const occasions = ctx.store.wikiOccasions;
  const day = { projectId: 'p', kind: 'chat' as const, ref: 'sources/matrix/r/2026-11-07.md' };
  await occasions.record({ ...day, title: 'Chat 7 Nov', body: 'first', reopen: true });
  const [first] = await occasions.open('p');
  await occasions.close('p', [first!]);
  await occasions.record({ ...day, title: 'Chat 7 Nov', body: 'more', reopen: true });
  const [again] = await occasions.open('p');
  expect(again).toMatchObject({ ref: day.ref, body: 'more' });
  await occasions.close('p', [again!]);
  const rows = await ctx.db.selectFrom('wiki_occasions').select(['body', 'closed_at']).execute();
  expect(rows).toEqual([{ body: null, closed_at: expect.any(Date) }]);
});

it('leaves an occasion open that was reopened while a run read it', async () => {
  const occasions = ctx.store.wikiOccasions;
  const day = { projectId: 'p', kind: 'chat' as const, ref: 'sources/matrix/r/2026-11-08.md' };
  await occasions.record({ ...day, title: 'Chat 8 Nov', body: 'morning', reopen: true });
  const [read] = await occasions.open('p');
  await new Promise((resolve) => setTimeout(resolve, 5));
  // New messages arrive while the run is still working on what it read.
  await occasions.record({ ...day, title: 'Chat 8 Nov', body: 'evening', reopen: true });
  expect(await occasions.close('p', [read!])).toBe(0);
  const [still] = await occasions.open('p');
  expect(still).toMatchObject({ id: read!.id, body: 'evening' });
});

it('keeps the end of a long text and forgets a session on request', async () => {
  const occasions = ctx.store.wikiOccasions;
  const long = `${'a'.repeat(WIKI_OCCASION_BODY_LIMIT)}THE END`;
  await occasions.record({ projectId: 'p', kind: 'session', ref: 's1', title: 'Fix', body: long });
  const [kept] = await occasions.open('p');
  expect(Buffer.byteLength(kept!.body!)).toBeLessThanOrEqual(WIKI_OCCASION_BODY_LIMIT);
  expect(kept!.body!.endsWith('THE END')).toBe(true);
  expect(await occasions.projectsWithOpen(new Date(Date.now() + 1000))).toEqual(['p']);
  await occasions.forgetSession('p', 's1');
  expect(await occasions.countOpen('p')).toBe(0);
});

it('reads only the end of a long conversation, without tool output or notices', async () => {
  await ctx.store.createSession({ sessionId: 's2', worktree: '/s2', model: 'm' });
  const chunk = 'x'.repeat(WIKI_OCCASION_BODY_LIMIT / 2);
  const rows = [
    { role: 'user' as const, kind: 'prompt' as const, text: `OLDEST ${chunk}` },
    { role: 'agent' as const, kind: 'text' as const, text: `MIDDLE ${chunk}` },
    { role: 'agent' as const, kind: 'notice' as const, text: 'NOTICE' },
    { role: 'user' as const, kind: 'prompt' as const, text: `LATEST ${chunk}` },
  ];
  await ctx.db
    .insertInto('messages')
    .values(
      rows.map((row, seq) => ({
        ...row,
        session_id: 's2',
        first_event_seq: seq,
        last_event_seq: seq,
        created_at: new Date(),
      })),
    )
    .execute();
  const transcript = await ctx.store.wikiOccasions.sessionTranscript('s2');
  // The oldest message lies wholly beyond the bound and is never loaded.
  expect(transcript).not.toContain('OLDEST');
  expect(transcript).toContain('Verity: MIDDLE');
  expect(transcript).not.toContain('NOTICE');
  expect(transcript.endsWith(`User: LATEST ${chunk}`)).toBe(true);
});

it('reports how much is waiting and discards only what is older than the cutoff', async () => {
  const occasions = ctx.store.wikiOccasions;
  expect(await occasions.pending('p')).toEqual({ count: 0, oldestAt: null, newestAt: null });
  await occasions.record({ projectId: 'p', kind: 'merge', ref: 'pr/1', title: 'Merged #1' });
  await ctx.db
    .updateTable('wiki_occasions')
    .set({ created_at: new Date('2026-01-01T00:00:00Z') })
    .execute();
  await occasions.record({ projectId: 'p', kind: 'merge', ref: 'pr/2', title: 'Merged #2' });
  const pending = await occasions.pending('p');
  expect(pending.count).toBe(2);
  expect(pending.oldestAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  expect(pending.newestAt!.getTime()).toBeGreaterThan(pending.oldestAt!.getTime());
  expect(await occasions.discardOpenBefore('p', new Date('2026-02-01T00:00:00Z'))).toBe(1);
  expect((await occasions.open('p')).map((occasion) => occasion.ref)).toEqual(['pr/2']);
});

it('starts at most one run inside the interval, and a released claim may run again', async () => {
  const runs = ctx.store.wikiMaintenance;
  const first = new Date('2026-11-01T10:00:00Z');
  const interval = 20 * 60 * 60 * 1000;
  const claim = (at: Date) => runs.claimRun('p', at, new Date(at.getTime() - interval));
  expect(await claim(first)).toBe(true);
  // A second generation in the same pass, or an hour later, loses.
  expect(await claim(first)).toBe(false);
  expect(await claim(new Date(first.getTime() + 60 * 60 * 1000))).toBe(false);
  const later = new Date(first.getTime() + interval);
  expect(await claim(later)).toBe(true);
  // A run that could not start gives its slot back.
  await runs.releaseRun('p', later, first);
  expect((await runs.get('p'))?.lastRunAt?.toISOString()).toBe(first.toISOString());
  expect(await claim(later)).toBe(true);
});

it('knows the maintenance session and forgets it with the session', async () => {
  const runs = ctx.store.wikiMaintenance;
  await ctx.store.createSession({ sessionId: 'm', worktree: '/m', model: 'm', projectId: 'p' });
  await runs.setSession('p', 'm');
  expect(await runs.isSession('m')).toBe(true);
  expect(await runs.sessionIds()).toEqual(new Set(['m']));
  await ctx.db.deleteFrom('sessions').where('session_id', '=', 'm').execute();
  expect(await runs.isSession('m')).toBe(false);
  expect((await runs.get('p'))?.sessionId).toBeNull();
});
