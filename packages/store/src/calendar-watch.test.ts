import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CalendarWatchStore, calendarEventKey } from './calendar-watch.js';
import { createSecretCipher } from './crypto.js';
import { createTestDb, type TestDb } from './testing.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});

it('watches, updates and stops watching calendars per account', async () => {
  const account = await ctx.store.googleAccounts.save({
    email: 'watch@example.com',
    clientId: 'client',
    refreshToken: 'secret',
    scopes: [],
  });
  const watch = ctx.store.calendarWatch;
  await watch.watch({
    accountId: account.id,
    calendarId: 'work',
    summary: 'Work',
    autoJoin: false,
  });
  await watch.watch({ accountId: account.id, calendarId: 'work', summary: 'Job', autoJoin: true });
  await watch.watch({
    accountId: account.id,
    calendarId: 'home',
    summary: 'Home',
    autoJoin: false,
  });
  expect(await watch.list()).toEqual([
    { accountId: account.id, calendarId: 'home', summary: 'Home', autoJoin: false },
    { accountId: account.id, calendarId: 'work', summary: 'Job', autoJoin: true },
  ]);
  await watch.unwatch(account.id, 'home');
  expect((await watch.list()).map((item) => item.calendarId)).toEqual(['work']);
});

// A disconnected account must not leave a calendar the watcher keeps trying to read.
it('forgets the calendars of a disconnected account', async () => {
  const account = await ctx.store.googleAccounts.save({
    email: 'gone@example.com',
    clientId: 'client',
    refreshToken: 'secret',
    scopes: [],
  });
  await ctx.store.calendarWatch.watch({
    accountId: account.id,
    calendarId: 'primary',
    summary: 'Gone',
    autoJoin: false,
  });
  await ctx.store.googleAccounts.remove(account.id);
  expect((await ctx.store.calendarWatch.list()).some((item) => item.accountId === account.id)).toBe(
    false,
  );
});

describe('watched events', () => {
  const MIN = 60_000;
  const window = { from: 0, to: 24 * 60 * MIN };
  const event = (eventId: string, startsAt: number) => ({
    eventId,
    title: `Meeting ${eventId}`,
    meetingUrl: `https://meet.google.com/${eventId}?pwd=secret`,
    startsAt,
    endsAt: startsAt + 30 * MIN,
    accepted: true,
  });
  let watch: CalendarWatchStore;
  let accountId: string;
  beforeAll(async () => {
    watch = new CalendarWatchStore(ctx.db, createSecretCipher('cd'.repeat(32)));
    accountId = (
      await ctx.store.googleAccounts.save({
        email: 'events@example.com',
        clientId: 'client',
        refreshToken: 'secret',
        scopes: [],
      })
    ).id;
    await watch.watch({ accountId, calendarId: 'cal', summary: 'Cal', autoJoin: false });
  });
  const mine = async () =>
    (await watch.listEvents()).filter((item) => item.accountId === accountId);

  // Links carry meeting passcodes; they must not sit in the database in plain text.
  it('keeps title and link encrypted at rest', async () => {
    await watch.syncEvents(accountId, 'cal', window, [event('a', 10 * MIN)]);
    const raw = await ctx.db
      .selectFrom('calendar_watch_events')
      .select(['title', 'meeting_url'])
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(raw.meeting_url).not.toContain('secret');
    expect(raw.title).not.toContain('Meeting');
    expect((await mine())[0]).toMatchObject({
      key: calendarEventKey(accountId, 'cal', 'a'),
      title: 'Meeting a',
      meetingUrl: 'https://meet.google.com/a?pwd=secret',
      notifiedAt: null,
      decision: null,
    });
  });

  it('announces a moved event again but never forgets a joined one', async () => {
    const a = calendarEventKey(accountId, 'cal', 'a');
    const b = calendarEventKey(accountId, 'cal', 'b');
    await watch.syncEvents(accountId, 'cal', window, [event('a', 10 * MIN), event('b', 60 * MIN)]);
    await watch.markNotified(a);
    await watch.markNotified(b);
    expect(await watch.claimJoin(b)).toBe(true);
    // Unchanged events keep their markers on the next pass.
    await watch.syncEvents(accountId, 'cal', window, [event('a', 10 * MIN), event('b', 60 * MIN)]);
    expect((await mine()).every((item) => item.notifiedAt !== null)).toBe(true);
    await watch.syncEvents(accountId, 'cal', window, [event('a', 20 * MIN), event('b', 90 * MIN)]);
    expect(await watch.getEvent(a)).toMatchObject({ notifiedAt: null, startsAt: 20 * MIN });
    expect(await watch.getEvent(b)).toMatchObject({ decision: 'joined' });
    await watch.syncEvents(accountId, 'cal', window, []);
    expect((await mine()).map((item) => item.key)).toEqual([b]);
  });

  // A tap on the notification, the app and the automatic join can race; only one bot may join.
  it('lets only one caller claim the join', async () => {
    await watch.syncEvents(accountId, 'cal', window, [event('c', 30 * MIN)]);
    const key = calendarEventKey(accountId, 'cal', 'c');
    expect(await watch.skip(key)).toBe(true);
    // A Skip landing just before the automatic join wins; a person may still change their mind.
    expect(await watch.claimJoin(key, { automatic: true })).toBe(false);
    const claims = await Promise.all([watch.claimJoin(key), watch.claimJoin(key)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await watch.skip(key)).toBe(false);
    // A bot that could not start gives the meeting back for another try.
    await watch.releaseJoin(key);
    expect(await watch.getEvent(key)).toMatchObject({ decision: null });
    expect(await watch.claimJoin(key)).toBe(true);
    // A process that stopped before the bot started leaves a claim nothing else resolves.
    await watch.releaseUnfinishedJoins();
    expect(await watch.getEvent(key)).toMatchObject({ decision: null });
    expect(await watch.claimJoin(key)).toBe(true);
    // A claim lost while its bot was starting is locked again by the started bot.
    await watch.releaseUnfinishedJoins();
    await watch.setJoinResult(key, { meetingId: 'meeting-1' });
    expect(await watch.claimJoin(key, { automatic: true })).toBe(false);
    await watch.releaseUnfinishedJoins();
    expect(await watch.claimJoin(key)).toBe(false);
    expect(await watch.getEvent(key)).toMatchObject({ decision: 'joined', meetingId: 'meeting-1' });
  });

  it('drops events with their calendar and after they ended', async () => {
    await watch.pruneEvents(10 * 24 * 60 * MIN);
    expect(await mine()).toEqual([]);
    await watch.syncEvents(accountId, 'cal', window, [event('d', 30 * MIN)]);
    await watch.unwatch(accountId, 'cal');
    expect(await mine()).toEqual([]);
  });
});
