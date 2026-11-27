import { describe, expect, it } from 'vitest';
import { app, ctx, isBusy } from './server-fixture.test-helper.js';

describe('background activity visibility', () => {
  it('keeps background work visible while the main agent awaits input and settles on termination', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(true);
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.appendEvent('s1', { t: 'task', id: 'child', phase: 'started' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'awaiting_input' });
    const activity = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(activity.json()).toMatchObject({ busy: true, activityAnimating: true });
    const overview = await app.inject({ method: 'GET', url: '/sessions' });
    expect(overview.json()[0]).toMatchObject({ status: 'awaiting_input', backgroundWorking: true });
    await ctx.store.appendEvent('s1', { t: 'task', id: 'child', phase: 'ended' });
    const waiting = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(waiting.json()).toMatchObject({ busy: true, activityAnimating: false });
    await ctx.store.appendEvent('s1', { t: 'task', id: 'orphan', phase: 'started' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'completed' });
    isBusy.mockReturnValue(false);
    const ended = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(ended.json()).toMatchObject({ busy: false, activityAnimating: false });
  });
});
