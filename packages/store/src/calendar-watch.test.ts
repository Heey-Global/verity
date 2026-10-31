import { afterAll, beforeAll, expect, it } from 'vitest';
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
