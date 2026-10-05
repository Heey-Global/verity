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
  app.inject({ method: 'POST', url: `/sessions/${id}/planning`, payload: { action } });

describe('planning routes', () => {
  it('implements the plan as a turn of its own behind the planning turn', async () => {
    await store.setSessionPlanning('s1', 'active');
    const res = await decide('implement');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ planning: 'implemented' });
    expect((await store.getSession('s1'))?.planning).toBe('implemented');
    // Steered into the still-running planning turn, the implementation would run
    // under the read-only posture the operator just ended.
    expect(dispatchTurn).toHaveBeenCalledWith(
      's1',
      IMPLEMENT_PLAN_PROMPT,
      {},
      { displayPrompt: IMPLEMENT_PLAN_DISPLAY, queueBehindActiveTurn: true },
    );
  });

  it('discards the plan without starting a turn', async () => {
    await store.setSessionPlanning('s1', 'active');
    const res = await decide('discard');
    expect(res.json()).toEqual({ planning: 'discarded' });
    expect((await store.getSession('s1'))?.planning).toBe('discarded');
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('starts only one implementation when two decisions race', async () => {
    await store.setSessionPlanning('s1', 'active');
    const results = await Promise.all([decide('implement'), decide('implement')]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    expect(dispatchTurn).toHaveBeenCalledOnce();
  });

  it('keeps planning active when the implementation turn cannot be dispatched', async () => {
    await store.setSessionPlanning('s1', 'active');
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
