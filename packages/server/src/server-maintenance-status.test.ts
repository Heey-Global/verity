import { describe, expect, it } from 'vitest';
import { app, ctx, isBusy } from './server-fixture.test-helper.js';

// Housekeeping (storage reclamation, branch switch, backend handoff) holds the
// same per-session lock as a turn. The overview used to read that lock as a
// running agent, so a background pass visiting idle sessions one after another
// made each of them flash "Agent working" on Home.
describe('session status while maintenance holds the turn lock', () => {
  const maintenanceOnly = (_id: string, options?: { turnOnly?: boolean }) =>
    options?.turnOnly !== true;

  it('keeps a finished session completed in the overview and session read', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'completed' });
    isBusy.mockImplementation(maintenanceOnly);

    const overview = await app.inject({ method: 'GET', url: '/sessions' });
    expect(overview.json()[0]).toMatchObject({ sessionId: 's1', status: 'completed' });
    const detail = await app.inject({ method: 'GET', url: '/sessions/s1' });
    expect(detail.json()).toMatchObject({ status: 'completed' });
    // The lock itself is still reported, so new turns keep waiting behind it.
    const activity = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(activity.json()).toMatchObject({ busy: true });
  });

  it('still overlays a real turn in flight as running', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'completed' });
    isBusy.mockReturnValue(true);

    const overview = await app.inject({ method: 'GET', url: '/sessions' });
    expect(overview.json()[0]).toMatchObject({ sessionId: 's1', status: 'running' });
    const detail = await app.inject({ method: 'GET', url: '/sessions/s1' });
    expect(detail.json()).toMatchObject({ status: 'running' });
  });
});
