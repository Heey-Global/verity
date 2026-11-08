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
  expect(await occasions.close('p', [open!.id])).toBe(1);
  // The status cache refills after a restart and reports the merge again.
  expect(await occasions.record(merge)).toBe(false);
  expect(await occasions.countOpen('p')).toBe(0);
});

it('opens a growing chat day again and drops kept text once read', async () => {
  const occasions = ctx.store.wikiOccasions;
  const day = { projectId: 'p', kind: 'chat' as const, ref: 'sources/matrix/r/2026-11-07.md' };
  await occasions.record({ ...day, title: 'Chat 7 Nov', body: 'first', reopen: true });
  const [first] = await occasions.open('p');
  await occasions.close('p', [first!.id]);
  await occasions.record({ ...day, title: 'Chat 7 Nov', body: 'more', reopen: true });
  const [again] = await occasions.open('p');
  expect(again).toMatchObject({ ref: day.ref, body: 'more' });
  await occasions.close('p', [again!.id]);
  const rows = await ctx.db.selectFrom('wiki_occasions').select(['body', 'closed_at']).execute();
  expect(rows).toEqual([{ body: null, closed_at: expect.any(Date) }]);
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
