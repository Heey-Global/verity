import type { WatchedCalendar } from '@verity/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerCalendarWatchRoutes } from './calendar-watch-routes.js';

const CALENDAR_SCOPES = ['calendar.calendarlist.readonly', 'calendar.events'].map(
  (scope) => `https://www.googleapis.com/auth/${scope}`,
);

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function fixture(options: { googleStatus?: number; watched?: WatchedCalendar[] } = {}) {
  let watched = [...(options.watched ?? [])];
  const accounts = [
    { id: 'work', email: 'me@work.example', displayName: 'Work', scopes: CALENDAR_SCOPES },
    { id: 'drive-only', email: 'me@home.example', displayName: null, scopes: [] },
  ];
  const calendarWatch = {
    list: vi.fn(async () => watched),
    watch: vi.fn(async (calendar: WatchedCalendar) => {
      watched = [
        ...watched.filter(
          (item) =>
            item.accountId !== calendar.accountId || item.calendarId !== calendar.calendarId,
        ),
        calendar,
      ];
    }),
    unwatch: vi.fn(async (accountId: string, calendarId: string) => {
      watched = watched.filter(
        (item) => item.accountId !== accountId || item.calendarId !== calendarId,
      );
    }),
  };
  const fetch = vi.fn(async () => ({
    status: options.googleStatus ?? 200,
    ok: (options.googleStatus ?? 200) === 200,
    json: async () => ({
      items: [
        { id: 'team@group', summary: 'Team', accessRole: 'reader' },
        {
          id: 'me@work.example',
          summary: 'me@work.example',
          summaryOverride: 'Mine',
          primary: true,
          accessRole: 'owner',
        },
        { id: 'holidays', summary: 'Busy only', accessRole: 'freeBusyReader' },
      ],
    }),
  }));
  const googleAccessToken = vi.fn(async (accountId?: string) => `token-${accountId ?? ''}`);
  app = Fastify();
  registerCalendarWatchRoutes(app, {
    store: {
      googleAccounts: {
        list: async () => accounts,
        get: async (id: string) => accounts.find((account) => account.id === id),
      },
      calendarWatch,
      getVeritySettingsRaw: async () => ({ unassignedMeetingRetentionDays: 14 }),
    } as never,
    googleAccessToken,
    fetch: fetch as never,
    log: { warn: vi.fn() },
  });
  return { app, calendarWatch, fetch, googleAccessToken };
}

it('lists readable calendars per account, primary first, with the watch choices', async () => {
  const { app } = fixture({
    watched: [{ accountId: 'work', calendarId: 'team@group', summary: 'Team', autoJoin: true }],
  });
  const response = await app.inject({ method: 'GET', url: '/settings/calendar-watch' });
  expect(response.json()).toEqual({
    retentionDays: 14,
    accounts: [
      {
        id: 'work',
        email: 'me@work.example',
        displayName: 'Work',
        access: 'ok',
        calendars: [
          {
            id: 'me@work.example',
            summary: 'Mine',
            primary: true,
            watched: false,
            autoJoin: false,
          },
          { id: 'team@group', summary: 'Team', primary: false, watched: true, autoJoin: true },
        ],
      },
      {
        id: 'drive-only',
        email: 'me@home.example',
        displayName: null,
        access: 'missing_scope',
        calendars: [],
      },
    ],
  });
});

// A revoked account must still show what is watched, or the operator could not turn it off.
it('keeps watched calendars visible when Google cannot be asked', async () => {
  const { app } = fixture({
    googleStatus: 401,
    watched: [{ accountId: 'work', calendarId: 'team@group', summary: 'Team', autoJoin: false }],
  });
  const body = (await app.inject({ method: 'GET', url: '/settings/calendar-watch' })).json();
  expect(body.accounts[0]).toMatchObject({
    access: 'unavailable',
    calendars: [{ id: 'team@group', summary: 'Team', watched: true, autoJoin: false }],
  });
});

it('watches a calendar under the name Google reports', async () => {
  const { app, calendarWatch } = fixture();
  const response = await app.inject({
    method: 'PUT',
    url: '/settings/calendar-watch',
    payload: { accountId: 'work', calendarId: 'me@work.example', watched: true, autoJoin: true },
  });
  expect(response.statusCode).toBe(200);
  expect(calendarWatch.watch).toHaveBeenCalledWith({
    accountId: 'work',
    calendarId: 'me@work.example',
    summary: 'Mine',
    autoJoin: true,
  });
});

it.each([
  ['a calendar that only shows busy times', 'work', 'holidays', 404],
  ['a calendar the account does not have', 'work', 'elsewhere', 404],
  ['an account without Calendar access', 'drive-only', 'primary', 409],
  ['an unknown account', 'nobody', 'primary', 404],
])('refuses to watch %s', async (_, accountId, calendarId, status) => {
  const { app, calendarWatch } = fixture();
  const response = await app.inject({
    method: 'PUT',
    url: '/settings/calendar-watch',
    payload: { accountId, calendarId, watched: true },
  });
  expect(response.statusCode).toBe(status);
  expect(calendarWatch.watch).not.toHaveBeenCalled();
});

it('stops watching without asking Google', async () => {
  const { app, calendarWatch, googleAccessToken } = fixture({
    watched: [{ accountId: 'work', calendarId: 'team@group', summary: 'Team', autoJoin: true }],
  });
  const response = await app.inject({
    method: 'PUT',
    url: '/settings/calendar-watch',
    payload: { accountId: 'work', calendarId: 'team@group', watched: false },
  });
  expect(response.json()).toEqual({ watched: false, autoJoin: false });
  expect(calendarWatch.unwatch).toHaveBeenCalledWith('work', 'team@group');
  expect(googleAccessToken).not.toHaveBeenCalled();
});

it('answers 502 when Google fails while choosing a calendar', async () => {
  const { app } = fixture({ googleStatus: 500 });
  const response = await app.inject({
    method: 'PUT',
    url: '/settings/calendar-watch',
    payload: { accountId: 'work', calendarId: 'team@group', watched: true },
  });
  expect(response.statusCode).toBe(502);
});
