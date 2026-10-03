import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './testing.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
it('keeps legacy authorization session-only and grants project access only explicitly', async () => {
  for (const id of ['google-p1', 'google-p2'])
    await ctx.store.upsertProject({
      id,
      owner: 'local',
      repo: id,
      containerName: id,
      state: 'active',
    });
  for (const [sessionId, projectId] of [
    ['google-s1', 'google-p1'],
    ['google-s2', 'google-p1'],
    ['google-s3', 'google-p2'],
  ])
    await ctx.store.createSession({
      sessionId: sessionId!,
      projectId: projectId!,
      worktree: `/wt/${sessionId}`,
      model: 'claude-opus-4-8',
    });
  for (const service of ['gmail', 'calendar', 'contacts'] as const) {
    const get =
      service === 'gmail'
        ? ctx.store.getSessionGmailConnection.bind(ctx.store)
        : service === 'calendar'
          ? ctx.store.getSessionCalendarConnection.bind(ctx.store)
          : ctx.store.getSessionContactsConnection.bind(ctx.store);
    if (service === 'gmail') await ctx.store.enableSessionGmail('google-s1', 'me@example.test');
    if (service === 'calendar')
      await ctx.store.enableSessionCalendar('google-s1', 'me@example.test');
    if (service === 'contacts')
      await ctx.store.enableSessionContacts('google-s1', 'me@example.test');
    expect(await get('google-s1')).toBeDefined();
    expect(await get('google-s2')).toBeUndefined();
    expect(await ctx.store.getProjectGoogleConnection('google-p1', service)).toBeUndefined();
    await ctx.store.enableProjectGoogleConnection('google-p1', service, 'me@example.test');
    expect(await get('google-s2')).toMatchObject({ accountEmail: 'me@example.test' });
    expect(await get('google-s3')).toBeUndefined();
    await ctx.store.disableProjectGoogleConnection('google-p1', service);
    expect(await get('google-s1')).toBeUndefined();
    expect(await get('google-s2')).toBeUndefined();
  }
});
