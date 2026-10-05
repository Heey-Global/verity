import { IMPLEMENT_PLAN_DISPLAY, IMPLEMENT_PLAN_PROMPT } from '@verity/events';
import { EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionPlanning, registerPlanningRoutes, type PlanningDeps } from './planning.js';

let ctx: TestDb;
let app: FastifyInstance;
let store: EventStore;
let dispatchTurn: ReturnType<typeof vi.fn<PlanningDeps['dispatchTurn']>>;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  store = new EventStore(ctx.db);
  await store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
  dispatchTurn = vi.fn<PlanningDeps['dispatchTurn']>(async () => ({ queued: true }));
  app = Fastify();
  const planning = createSessionPlanning({ eventStore: store, dispatchTurn });
  registerPlanningRoutes(app, { eventStore: store, planning });
});
afterEach(async () => app.close());

const decide = (action: string, id = 's1') =>
  app.inject({
    method: 'POST',
    url: `/sessions/${id}/planning`,
    payload: action === 'implement' ? { action, planningRevision: 1 } : { action },
  });

describe('planning routes', () => {
  it('implements the plan as a turn of its own behind the planning turn', async () => {
    await store.setSessionPlanning('s1', 'active');
    await store.presentSessionPlan('s1', '1. Do it');
    const res = await decide('implement');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ planning: 'implemented' });
    expect((await store.getSession('s1'))?.planning).toBe('implemented');
    // Steered into the still-running planning turn, the implementation would run
    // under the read-only posture the operator just ended.
    expect(dispatchTurn).toHaveBeenCalledWith(
      's1',
      `${IMPLEMENT_PLAN_PROMPT}\n\nApproved plan (revision 1):\n1. Do it`,
      {},
      { displayPrompt: IMPLEMENT_PLAN_DISPLAY, queueBehindActiveTurn: true },
    );
  });

  it('refuses an approval from a device that still shows the previous plan', async () => {
    await store.startSessionPlanning('s1');
    const oldRevision = await store.presentSessionPlan('s1', 'Old plan');
    const currentRevision = await store.presentSessionPlan('s1', 'Revised plan');
    const stale = await app.inject({
      method: 'POST',
      url: '/sessions/s1/planning',
      payload: { action: 'implement', planningRevision: oldRevision },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'stalePlan', planningRevision: currentRevision });
    expect(dispatchTurn).not.toHaveBeenCalled();
    const current = await app.inject({
      method: 'POST',
      url: '/sessions/s1/planning',
      payload: { action: 'implement', planningRevision: currentRevision },
    });
    expect(current.statusCode).toBe(200);
    expect(dispatchTurn.mock.calls[0]?.[1]).toContain('Revised plan');
    expect(dispatchTurn.mock.calls[0]?.[1]).not.toContain('Old plan');
  });

  it('checks the revision atomically when a newer plan arrives after the initial read', async () => {
    await store.startSessionPlanning('s1');
    const oldRevision = await store.presentSessionPlan('s1', 'Original plan');
    const originalSet = store.setSessionPlanning.bind(store);
    vi.spyOn(store, 'setSessionPlanning').mockImplementationOnce(async (...args) => {
      await store.presentSessionPlan('s1', 'Racing revision');
      return originalSet(...args);
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/planning',
      payload: { action: 'implement', planningRevision: oldRevision },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'stalePlan' });
    expect(dispatchTurn).not.toHaveBeenCalled();
    expect((await store.getSession('s1'))?.planning).toBe('active');
  });

  it('never reuses a revision across planning rounds', async () => {
    await store.startSessionPlanning('s1');
    const oldRevision = await store.presentSessionPlan('s1', 'First round');
    await decide('discard');
    await store.startSessionPlanning('s1');
    const currentRevision = await store.presentSessionPlan('s1', 'Second round');
    expect(currentRevision).toBeGreaterThan(oldRevision!);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/planning',
      payload: { action: 'implement', planningRevision: oldRevision },
    });
    expect(res.json()).toMatchObject({ code: 'stalePlan' });
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('discards the plan without starting a turn', async () => {
    await store.setSessionPlanning('s1', 'active');
    await store.presentSessionPlan('s1', '1. Do it');
    const res = await decide('discard');
    expect(res.json()).toEqual({ planning: 'discarded' });
    expect((await store.getSession('s1'))?.planning).toBe('discarded');
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('starts only one implementation when two decisions race', async () => {
    await store.setSessionPlanning('s1', 'active');
    await store.presentSessionPlan('s1', '1. Do it');
    const results = await Promise.all([decide('implement'), decide('implement')]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    expect(dispatchTurn).toHaveBeenCalledOnce();
  });

  it('keeps planning active when the implementation turn cannot be dispatched', async () => {
    await store.setSessionPlanning('s1', 'active');
    await store.presentSessionPlan('s1', '1. Do it');
    dispatchTurn.mockRejectedValueOnce(new Error('queue full'));
    const res = await decide('implement');
    expect(res.statusCode).toBe(500);
    // Reporting planning as over with nothing implementing it would strand the
    // operator: no button, no implementation, no planning bar.
    expect((await store.getSession('s1'))?.planning).toBe('active');
  });

  it('refuses a session that is not planning and an unknown session', async () => {
    expect((await decide('discard')).statusCode).toBe(409);
    expect((await decide('implement', 'missing')).statusCode).toBe(404);
  });
});
