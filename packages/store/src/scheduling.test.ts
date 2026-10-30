import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreateSchedulingDraft } from './scheduling.js';
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
});

const draft = (
  id: string,
  overrides: Partial<CreateSchedulingDraft> = {},
): CreateSchedulingDraft => ({
  id,
  sessionId: 's1',
  projectId: null,
  googleAccountId: 'acct',
  calendarId: 'primary',
  timeZone: 'Europe/Berlin',
  language: 'en',
  title: 'Intro call',
  durationMinutes: 30,
  addMeet: true,
  organizerName: 'Sam',
  organizerEmail: 'holger@example.test',
  guestEmail: 'anna@example.test',
  guestName: 'Anna',
  colleagues: [{ email: 'lea@example.test', name: 'Lea' }],
  emailSubject: 'Pick a time',
  emailBody: 'Hi Anna',
  closesAt: new Date('2026-11-06T10:00:00Z'),
  windows: [
    {
      start: new Date('2026-11-03T13:00:00Z'),
      end: new Date('2026-11-03T15:00:00Z'),
      eventId: 'ev0',
    },
    {
      start: new Date('2026-11-04T09:00:00Z'),
      end: new Date('2026-11-04T10:00:00Z'),
      eventId: 'ev1',
    },
  ],
  ...overrides,
});

describe('scheduling requests', () => {
  it('stores a draft with its windows and keeps drafts out of the request lists', async () => {
    const request = await ctx.store.scheduling.createDraft(draft('r1'));
    expect(request).toMatchObject({
      state: 'draft',
      colleagues: [{ email: 'lea@example.test', name: 'Lea' }],
      hasShare: false,
      durationMinutes: 30,
    });
    expect(
      (await ctx.store.scheduling.holds('r1')).map((hold) => [hold.eventId, hold.state]),
    ).toEqual([
      ['ev0', 'pending'],
      ['ev1', 'pending'],
    ]);
    expect(await ctx.store.scheduling.listForSession('s1')).toEqual([]);
    expect(await ctx.store.scheduling.approve('r1', 'digest')).toBe(true);
    expect((await ctx.store.scheduling.listForSession('s1')).map((r) => r.id)).toEqual(['r1']);
  });

  it('approves a draft once and transitions only from the expected states', async () => {
    await ctx.store.scheduling.createDraft(draft('r1'));
    expect(await ctx.store.scheduling.approve('r1', 'digest')).toBe(true);
    expect(await ctx.store.scheduling.approve('r1', 'digest')).toBe(false);
    const results = await Promise.all([
      ctx.store.scheduling.transition('r1', ['provisioning'], 'open'),
      ctx.store.scheduling.transition('r1', ['provisioning'], 'failed', { failure: 'x' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ctx.store.scheduling.transition('r1', ['draft'], 'revoked')).toBe(false);
  });

  it('keeps the share binding encrypted at rest and lists it until revoked', async () => {
    await ctx.store.scheduling.createDraft(draft('r1'));
    const binding = {
      shareId: 'share',
      publicOrigin: 'https://x.preview.example.test',
      edgeUrl: 'wss://edge.example.test',
      connectorToken: 'connector-token',
      sessionSecret: 'session-secret',
      pin: '123456',
      expiresAt: '2026-11-29T10:00:00.000Z',
    };
    await ctx.store.scheduling.setShare('r1', binding);
    expect(await ctx.store.scheduling.share('r1')).toEqual(binding);
    expect((await ctx.store.scheduling.get('r1'))?.linkExpiresAt?.toISOString()).toBe(
      binding.expiresAt,
    );
    expect((await ctx.store.scheduling.listServed()).map((r) => r.id)).toEqual(['r1']);
    await ctx.store.scheduling.update('r1', { shareRevokedAt: new Date() });
    expect(await ctx.store.scheduling.listServed()).toEqual([]);
  });

  it('finds deadlines, provisioning and hold cleanups that are due', async () => {
    await ctx.store.scheduling.createDraft(draft('open'));
    await ctx.store.scheduling.approve('open', 'd');
    await ctx.store.scheduling.transition('open', ['provisioning'], 'open');
    await ctx.store.scheduling.createDraft(
      draft('later', { closesAt: new Date('2026-12-01T00:00:00Z') }),
    );
    await ctx.store.scheduling.approve('later', 'd');
    await ctx.store.scheduling.transition('later', ['provisioning'], 'open');
    await ctx.store.scheduling.createDraft(
      draft('draft-only', { closesAt: new Date('2020-01-01T00:00:00Z') }),
    );

    const now = new Date('2026-11-07T00:00:00Z');
    expect((await ctx.store.scheduling.dueRequests(now)).map((r) => r.id)).toEqual(['open']);
    expect((await ctx.store.scheduling.nextDueAt())?.toISOString()).toBe(
      '2026-11-06T10:00:00.000Z',
    );

    await ctx.store.scheduling.updateHold('open', 0, { state: 'active' });
    await ctx.store.scheduling.updateHold('open', 1, { state: 'active' });
    await ctx.store.scheduling.scheduleHoldCleanup('open', { except: 0 });
    expect(
      (await ctx.store.scheduling.dueHoldCleanups(new Date(Date.now() + 1000))).map(
        (h) => h.position,
      ),
    ).toEqual([1]);
    expect((await ctx.store.scheduling.holds('open'))[0]?.state).toBe('active');
  });

  it('lets only one owner hold a request lease until it expires or is released', async () => {
    await ctx.store.scheduling.createDraft(draft('r1'));
    expect(await ctx.store.scheduling.lease('r1', 'a', 60_000)).toBe(true);
    expect(await ctx.store.scheduling.lease('r1', 'b', 60_000)).toBe(false);
    // Not even the holder itself: two tasks of one process must not overlap either.
    expect(await ctx.store.scheduling.lease('r1', 'a', 60_000)).toBe(false);
    await ctx.store.scheduling.release('r1', 'a');
    expect(await ctx.store.scheduling.lease('r1', 'b', 60_000)).toBe(true);
  });

  it('lets exactly one caller claim the email send', async () => {
    await ctx.store.scheduling.createDraft(draft('r1'));
    // Only an approved request that is still being set up may email its guest.
    expect(await ctx.store.scheduling.claimEmailSend('r1')).toBe(false);
    await ctx.store.scheduling.approve('r1', 'digest');
    const claims = await Promise.all([
      ctx.store.scheduling.claimEmailSend('r1'),
      ctx.store.scheduling.claimEmailSend('r1'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('serializes work on one calendar and writes through the locking transaction', async () => {
    await ctx.store.scheduling.createDraft(draft('r1'));
    const order: string[] = [];
    await Promise.all(
      ['first', 'second'].map((name) =>
        ctx.store.scheduling.withCalendarLock('acct:primary', async (locked) => {
          order.push(`${name}:start`);
          await locked.update('r1', { guestNote: name });
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push(`${name}:end`);
        }),
      ),
    );
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect((await ctx.store.scheduling.get('r1'))?.guestNote).toBe('second');
  });
});
