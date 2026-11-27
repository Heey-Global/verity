import { describe, expect, it } from 'vitest';
import { app, ctx } from './server-fixture.test-helper.js';

describe('GET /projects/:id sessions', () => {
  // The app keeps one copy of the sessions its lists read, and Home's read
  // speaks for every session. A session only the project page listed would be
  // dropped by each Home read and brought back by each page read.
  it('lists the sessions of the project exactly as /sessions does, maintenance ones left out', async () => {
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
      .filter((session) => session.projectId === 'p-hidden');
    const page = (await app.inject({ method: 'GET', url: '/projects/p-hidden' })).json<{
      sessions: Array<{ sessionId: string }>;
    }>().sessions;

    // Field for field: a row the page read with fewer fields would replace
    // Home's row in the app's shared copy and drop them there.
    const byId = (rows: Array<{ sessionId: string }>) =>
      [...rows].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(byId(page)).toEqual(byId(home));
    // Not vacuous: the visible session is on both.
    expect(page.map((session) => session.sessionId)).toEqual(['s-visible']);
  });

  // Verity's approvals wait in the V panel. Listed here as well, the assistant session put
  // each one on Home and in Control a second time, as a session to open and approve in.
  it('leaves the enabled assistant session out of every list, and lists it once switched off', async () => {
    await ctx.store.createSession({
      sessionId: 's-assistant',
      worktree: '/wt/s-assistant',
      model: 'm',
    });
    const listed = async () =>
      (await app.inject({ method: 'GET', url: '/sessions' }))
        .json<Array<{ sessionId: string }>>()
        .some((session) => session.sessionId === 's-assistant');
    await ctx.store.assistant.configure(true, 'admin');
    await ctx.store.assistant.session('s-assistant');
    try {
      expect(await listed()).toBe(false);
      // Hidden from lists only: the panel's expand button and Review in session open it.
      expect((await app.inject({ method: 'GET', url: '/sessions/s-assistant' })).statusCode).toBe(
        200,
      );
      await ctx.store.assistant.configure(false, 'admin');
      expect(await listed()).toBe(true);
    } finally {
      await ctx.store.assistant.configure(false, 'admin');
    }
  });
});
