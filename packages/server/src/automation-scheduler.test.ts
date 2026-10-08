import { EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startAutomationScheduler } from './automation-scheduler.js';

let ctx: TestDb;
let store: EventStore;

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
});

const log = { info: () => undefined, warn: () => undefined };
const created = new Date('2026-10-05T08:00:00');

describe('automation scheduler', () => {
  it('runs a due automation once and records its outcome', async () => {
    await store.setSessionAutomation(
      {
        sessionId: 's1',
        name: 'Morning review',
        schedule: { kind: 'daily', hour: 9, minute: 0 },
        prompt: 'Review.',
      },
      created,
    );
    const run = vi.fn(async () => ({ outcome: 'acted' as const, detail: null }));
    let clock = new Date('2026-10-05T09:00:30').getTime();
    const scheduler = startAutomationScheduler({ store, run, log, now: () => clock });
    try {
      await scheduler.runOnce();
      await scheduler.runOnce();
      expect(run).toHaveBeenCalledOnce();
      const after = await store.getSessionAutomation('s1');
      expect(after).toMatchObject({ lastOutcome: 'acted' });
      expect(after?.nextRunAt?.getTime()).toBe(new Date('2026-10-06T09:00:00').getTime());

      clock = new Date('2026-10-06T09:00:00').getTime();
      await scheduler.runOnce();
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.stop();
    }
  });

  it('does not run an automation before it is due or while it is paused', async () => {
    await store.setSessionAutomation(
      {
        sessionId: 's1',
        name: 'Review',
        schedule: { kind: 'interval', everyMinutes: 60 },
        prompt: 'Review.',
      },
      created,
    );
    const run = vi.fn(async () => ({ outcome: 'acted' as const, detail: null }));
    let clock = new Date('2026-10-05T08:30:00').getTime();
    const scheduler = startAutomationScheduler({ store, run, log, now: () => clock });
    try {
      await scheduler.runOnce();
      await store.setSessionAutomationStatus('s1', 'paused');
      clock = new Date('2026-10-05T12:00:00').getTime();
      await scheduler.runOnce();
      expect(run).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });

  it('records a thrown run as an error instead of stalling the pass', async () => {
    await store.setSessionAutomation(
      {
        sessionId: 's1',
        name: 'Review',
        schedule: { kind: 'interval', everyMinutes: 15 },
        prompt: 'Review.',
      },
      created,
    );
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    const scheduler = startAutomationScheduler({
      store,
      run,
      log,
      now: () => new Date('2026-10-05T09:00:00').getTime(),
    });
    try {
      await scheduler.runOnce();
      expect(await store.getSessionAutomation('s1')).toMatchObject({
        lastOutcome: 'error',
        lastDetail: 'boom',
        consecutiveErrorCount: 1,
      });
    } finally {
      scheduler.stop();
    }
  });
});
