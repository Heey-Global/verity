import { expect, it } from 'vitest';

import { bus, conductor, ctx, worktreeRoot } from './server-fixture.test-helper.js';
import { buildServer } from './server.js';

it('records who started a session, so its requests are theirs', async () => {
  await ctx.db
    .insertInto('users')
    .values({ id: 'mara', role: 'administrator', status: 'active' })
    .execute();
  const asMara = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    spawnWorktreeRoot: worktreeRoot,
  });
  asMara.addHook('onRequest', async (request) => {
    request.localUserId = 'mara';
  });
  try {
    const created = await asMara.inject({ method: 'POST', url: '/sessions', payload: {} });
    expect(created.statusCode, created.body).toBe(201);
    const { sessionId } = created.json<{ sessionId: string }>();
    expect((await ctx.store.sessionPeople.owners([sessionId])).get(sessionId)).toEqual(['mara']);
  } finally {
    await asMara.close();
  }
});
