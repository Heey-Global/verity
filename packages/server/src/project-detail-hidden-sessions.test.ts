import { describe, expect, it } from 'vitest';
import { app, ctx } from './server-fixture.test-helper.js';

describe('GET /projects/:id sessions', () => {
  // The app keeps one copy of the sessions its lists read, and Home's read
  // speaks for every session. A session only the project page listed would be
  // dropped by each Home read and brought back by each page read.
  it('lists the sessions of the project that /sessions lists, maintenance ones left out', async () => {
    await ctx.store.upsertProject({
      id: 'p-hidden',
      owner: 'heey-global',
      repo: 'hidden',
      containerName: 'dev-heey-global--hidden',
      state: 'active',
    });
    for (const sessionId of ['s-visible', 's-maintenance'])
      await ctx.store.createSession({
        sessionId,
        worktree: `/wt/${sessionId}`,
        model: 'm',
        projectId: 'p-hidden',
      });
    await ctx.store.wikiMaintenance.setSession('p-hidden', 's-maintenance');

    const home = (await app.inject({ method: 'GET', url: '/sessions' }))
      .json<Array<{ sessionId: string; projectId?: string | null }>>()
      .filter((session) => session.projectId === 'p-hidden')
      .map((session) => session.sessionId);
    const page = (await app.inject({ method: 'GET', url: '/projects/p-hidden' }))
      .json<{ sessions: Array<{ sessionId: string }> }>()
      .sessions.map((session) => session.sessionId);

    expect(page.sort()).toEqual(home.sort());
    // Not vacuous: the visible session is on both.
    expect(page).toEqual(['s-visible']);
  });
});
