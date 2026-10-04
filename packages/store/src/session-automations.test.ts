import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { computeNextRun } from './schedule.js';
import { SESSION_AUTOMATION_MAX_CONSECUTIVE_ERRORS } from './store.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
  await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
});

const daily = { kind: 'daily' as const, hour: 9, minute: 0 };
const input = {
  sessionId: 's1',
  name: 'Morning review',
  schedule: daily,
  prompt: 'Summarize the open pull requests.',
};

describe('EventStore — session automations', () => {
  it('creates an enabled prompt-only automation armed for its next slot', async () => {
    const now = new Date('2026-10-05T08:00:00');
    const automation = await ctx.store.setSessionAutomation(input, now);
    expect(automation).toMatchObject({
      sessionId: 's1',
      name: 'Morning review',
      status: 'enabled',
      schedule: daily,
      prompt: 'Summarize the open pull requests.',
      script: null,
      model: null,
    });
    expect(automation.nextRunAt?.getTime()).toBe(computeNextRun(daily, now).getTime());
    expect(await ctx.store.getSessionAutomation('s1')).toEqual(automation);
  });

  it('persists the user zone and reuses it when resuming after a DST change', async () => {
    const schedule = { ...daily, timeZone: 'Europe/Berlin' };
    const automation = await ctx.store.setSessionAutomation(
      { ...input, schedule },
      new Date('2026-10-24T06:00:00Z'),
    );
    expect(automation.nextRunAt?.toISOString()).toBe('2026-10-24T07:00:00.000Z');
    expect((await ctx.store.getSessionAutomation('s1'))?.schedule).toEqual(schedule);
    await ctx.store.setSessionAutomationStatus('s1', 'paused');
    const resumed = await ctx.store.setSessionAutomationStatus(
      's1',
      'enabled',
      new Date('2026-10-25T06:00:00Z'),
    );
    expect(resumed?.nextRunAt?.toISOString()).toBe('2026-10-25T08:00:00.000Z');
  });

  it('replaces the existing automation instead of adding a second one', async () => {
    const first = await ctx.store.setSessionAutomation(input);
    await ctx.store.recordSessionAutomationOutcome(first.id, { outcome: 'error', detail: 'x' });
    const second = await ctx.store.setSessionAutomation({
      ...input,
      name: 'Weekly review',
      schedule: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 },
      script: 'exit 10',
    });
    // A run of the first configuration may still be in flight; it must not be
    // able to claim or report against the replacement.
    expect(second.id).not.toBe(first.id);
    expect(
      await ctx.store.claimSessionAutomationRun(
        first.id,
        new Date('2100-01-01'),
        new Date('2100-01-02'),
      ),
    ).toBe(false);
    await ctx.store.recordSessionAutomationOutcome(first.id, { outcome: 'error', detail: 'stale' });
    expect((await ctx.store.getSessionAutomation('s1'))?.consecutiveErrorCount).toBe(0);
    expect(second).toMatchObject({
      name: 'Weekly review',
      script: 'exit 10',
      consecutiveErrorCount: 0,
      lastOutcome: null,
    });
    const due = await ctx.store.listDueSessionAutomations(new Date('2100-01-01'));
    expect(due.map((a) => a.sessionId)).toEqual(['s1']);
  });

  it('pausing disarms and resuming re-arms with a fresh error budget', async () => {
    const automation = await ctx.store.setSessionAutomation(input);
    await ctx.store.recordSessionAutomationOutcome(automation.id, {
      outcome: 'error',
      detail: 'x',
    });
    const paused = await ctx.store.setSessionAutomationStatus('s1', 'paused');
    expect(paused).toMatchObject({ status: 'paused', nextRunAt: null });
    expect(await ctx.store.nextSessionAutomationDueAt()).toBeNull();

    const resumed = await ctx.store.setSessionAutomationStatus('s1', 'enabled');
    expect(resumed).toMatchObject({ status: 'enabled', consecutiveErrorCount: 0 });
    expect(resumed?.nextRunAt).not.toBeNull();

    // Re-sending the current status keeps the armed slot and the error count.
    await ctx.store.recordSessionAutomationOutcome(automation.id, {
      outcome: 'error',
      detail: 'x',
    });
    const again = await ctx.store.setSessionAutomationStatus(
      's1',
      'enabled',
      new Date('2100-01-01'),
    );
    expect(again?.nextRunAt).toEqual(resumed?.nextRunAt);
    expect(again?.consecutiveErrorCount).toBe(1);
    expect(await ctx.store.setSessionAutomationStatus('s2', 'paused')).toBeUndefined();
  });

  it('is removed together with its session', async () => {
    await ctx.store.setSessionAutomation(input);
    await ctx.store.deleteSession('s1');
    expect(await ctx.store.getSessionAutomation('s1')).toBeUndefined();
    expect(await ctx.store.nextSessionAutomationDueAt()).toBeNull();
  });

  it('deletes only the automation, never the session', async () => {
    await ctx.store.setSessionAutomation(input);
    expect(await ctx.store.deleteSessionAutomation('s1')).toBe(true);
    expect(await ctx.store.deleteSessionAutomation('s1')).toBe(false);
    expect(await ctx.store.getSession('s1')).toBeDefined();
  });

  it('reports statuses only for sessions that have an automation', async () => {
    await ctx.store.setSessionAutomation(input);
    await ctx.store.setSessionAutomation({ ...input, sessionId: 's2' });
    await ctx.store.setSessionAutomationStatus('s2', 'paused');
    const statuses = await ctx.store.listSessionAutomationStatuses(['s1', 's2', 'missing']);
    expect([...statuses.entries()].sort()).toEqual([
      ['s1', 'enabled'],
      ['s2', 'paused'],
    ]);
    expect((await ctx.store.listSessionAutomationStatuses([])).size).toBe(0);
  });
});

describe('EventStore — session automation scheduling', () => {
  it('claims a due run exactly once and advances its due time', async () => {
    const created = new Date('2026-10-05T08:00:00');
    const automation = await ctx.store.setSessionAutomation(input, created);
    const ranAt = new Date('2026-10-05T09:00:00');
    expect(await ctx.store.listDueSessionAutomations(new Date('2026-10-05T08:59:00'))).toEqual([]);
    expect(await ctx.store.listDueSessionAutomations(ranAt)).toHaveLength(1);

    const next = computeNextRun(daily, ranAt);
    expect(await ctx.store.claimSessionAutomationRun(automation.id, ranAt, next)).toBe(true);
    expect(await ctx.store.claimSessionAutomationRun(automation.id, ranAt, next)).toBe(false);
    expect((await ctx.store.nextSessionAutomationDueAt())?.getTime()).toBe(next.getTime());
  });

  it('does not claim a paused automation', async () => {
    const automation = await ctx.store.setSessionAutomation(input, new Date('2026-10-05T08:00'));
    await ctx.store.setSessionAutomationStatus('s1', 'paused');
    expect(
      await ctx.store.claimSessionAutomationRun(
        automation.id,
        new Date('2100-01-01'),
        new Date('2100-01-02'),
      ),
    ).toBe(false);
  });

  it('pauses itself after repeated errors and resets the count after a success', async () => {
    const automation = await ctx.store.setSessionAutomation(input);
    await ctx.store.recordSessionAutomationOutcome(automation.id, {
      outcome: 'error',
      detail: 'a',
    });
    await ctx.store.recordSessionAutomationOutcome(automation.id, {
      outcome: 'skipped',
      detail: 'busy',
    });
    expect((await ctx.store.getSessionAutomation('s1'))?.consecutiveErrorCount).toBe(1);
    await ctx.store.recordSessionAutomationOutcome(automation.id, {
      outcome: 'acted',
      detail: null,
    });
    expect((await ctx.store.getSessionAutomation('s1'))?.consecutiveErrorCount).toBe(0);

    for (let i = 0; i < SESSION_AUTOMATION_MAX_CONSECUTIVE_ERRORS; i += 1) {
      await ctx.store.recordSessionAutomationOutcome(automation.id, {
        outcome: 'error',
        detail: 'Script failed with exit code 2',
      });
    }
    expect(await ctx.store.getSessionAutomation('s1')).toMatchObject({
      status: 'paused',
      nextRunAt: null,
      lastOutcome: 'error',
      lastDetail: 'Script failed with exit code 2',
    });
  });
});
