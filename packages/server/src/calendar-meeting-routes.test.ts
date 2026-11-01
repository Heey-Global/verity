import { calendarEventKey } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { OnlineMeetingStartError } from './attendee-meetings.js';
import { registerCalendarMeetingRoutes } from './calendar-meeting-routes.js';
import type { CalendarMeetingDeps } from './calendar-meeting-watcher.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-02T10:00:00Z');

let ctx: TestDb;
let app: FastifyInstance | undefined;
let accountId: string;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  accountId = (
    await ctx.store.googleAccounts.save({
      email: 'me@example.com',
      clientId: 'client',
      refreshToken: 'secret',
      scopes: [],
    })
  ).id;
  await ctx.store.calendarWatch.watch({
    accountId,
    calendarId: 'primary',
    summary: 'Work',
    autoJoin: false,
  });
  await ctx.store.calendarWatch.syncEvents(
    accountId,
    'primary',
    { from: NOW - 60 * MIN, to: NOW + 48 * 60 * MIN },
    [
      event('ended', NOW - 50 * MIN, 'https://meet.google.com/aaa'),
      event('soon', NOW + 5 * MIN, 'https://acme.zoom.us/j/1?pwd=secret'),
      event('tomorrow', NOW + 20 * 60 * MIN, 'https://teams.microsoft.com/l/x'),
    ],
  );
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function event(eventId: string, startsAt: number, meetingUrl: string) {
  return {
    eventId,
    title: `Meeting ${eventId}`,
    meetingUrl,
    startsAt,
    endsAt: startsAt + 30 * MIN,
    accepted: true,
  };
}
const key = (eventId: string) => calendarEventKey(accountId, 'primary', eventId);

function serve(start = vi.fn(async () => ({ meetingId: 'meeting-1' }))) {
  const send = vi.fn(async () => ({
    targets: 0,
    ticketsAccepted: 0,
    ticketErrors: 0,
    receiptsQueued: 0,
    pruned: 0,
    transportErrors: 0,
  }));
  app = Fastify();
  registerCalendarMeetingRoutes(app, {
    store: {
      calendarWatch: ctx.store.calendarWatch,
      listActiveAdministratorIds: async () => [],
      listDevicePushTokensForUsers: async () => [],
      getSession: async (id: string) =>
        id === 'session-1' ? ({ sessionId: id } as never) : undefined,
    },
    meetings: { start } as unknown as CalendarMeetingDeps['meetings'],
    sender: { send },
    googleAccessToken: async () => undefined,
    warn: vi.fn(),
    now: () => NOW,
  });
  return { app, start };
}

it('lists the meetings of the next hours without their links', async () => {
  const { app } = serve();
  const response = await app.inject({ method: 'GET', url: '/live-meetings/upcoming' });
  expect(response.json()).toEqual({
    upcoming: [
      {
        eventKey: key('soon'),
        title: 'Meeting soon',
        startsAt: NOW + 5 * MIN,
        endsAt: NOW + 35 * MIN,
        calendar: 'Work',
        provider: 'zoom',
        decision: null,
        meetingId: null,
      },
    ],
  });
  // The passcode in a link must not leave the server through this list.
  expect(response.body).not.toContain('pwd=');
});

it('joins into the session of the meeting screen', async () => {
  const { app, start } = serve();
  const response = await app.inject({
    method: 'POST',
    url: `/live-meetings/calendar/${key('soon')}/join`,
    payload: { sessionId: 'session-1' },
  });
  expect(response.json()).toEqual({ meetingId: 'meeting-1' });
  expect(start).toHaveBeenCalledWith(
    'session-1',
    'https://acme.zoom.us/j/1?pwd=secret',
    true,
    'Meeting soon',
  );
});

it('joins unassigned from a notification and refuses a second join', async () => {
  const { app, start } = serve();
  const url = `/live-meetings/calendar/${key('soon')}/join`;
  expect((await app.inject({ method: 'POST', url })).statusCode).toBe(200);
  const again = await app.inject({ method: 'POST', url, payload: {} });
  expect(again.statusCode).toBe(409);
  expect(again.json()).toMatchObject({ meetingId: 'meeting-1' });
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith(null, expect.any(String), true, 'Meeting soon');
  const skip = await app.inject({
    method: 'POST',
    url: `/live-meetings/calendar/${key('soon')}/skip`,
  });
  expect(skip.statusCode).toBe(409);
});

it('skips a meeting, and joining afterwards is still possible', async () => {
  const { app } = serve();
  const skip = await app.inject({
    method: 'POST',
    url: `/live-meetings/calendar/${key('soon')}/skip`,
  });
  expect(skip.json()).toEqual({ skipped: true });
  const list = (await app.inject({ method: 'GET', url: '/live-meetings/upcoming' })).json();
  expect(list.upcoming[0]).toMatchObject({ decision: 'skipped' });
  const join = await app.inject({
    method: 'POST',
    url: `/live-meetings/calendar/${key('soon')}/join`,
  });
  expect(join.statusCode).toBe(200);
});

it.each([
  ['an unknown meeting', 'unknown', 404],
  ['a meeting that ended', 'ended', 409],
  ['a meeting many hours ahead', 'tomorrow', 409],
])('refuses to join %s', async (_, eventId, status) => {
  const { app, start } = serve();
  const response = await app.inject({
    method: 'POST',
    url: `/live-meetings/calendar/${eventId === 'unknown' ? 'unknown' : key(eventId)}/join`,
  });
  expect(response.statusCode).toBe(status);
  expect(start).not.toHaveBeenCalled();
});

it('refuses to join into a session that does not exist, leaving the meeting open', async () => {
  const { app, start } = serve();
  const url = `/live-meetings/calendar/${key('soon')}/join`;
  const response = await app.inject({ method: 'POST', url, payload: { sessionId: 'gone' } });
  expect(response.statusCode).toBe(404);
  expect(start).not.toHaveBeenCalled();
  expect((await app.inject({ method: 'POST', url })).statusCode).toBe(200);
});

// A failure on a join someone asked for must not lock the meeting like a failed auto-join.
it('gives the meeting back when the bot fails for any reason', async () => {
  const start = vi
    .fn()
    .mockRejectedValueOnce(new Error('An online meeting is already active in this session.'))
    .mockResolvedValueOnce({ meetingId: 'meeting-3' });
  const { app } = serve(start);
  const url = `/live-meetings/calendar/${key('soon')}/join`;
  expect((await app.inject({ method: 'POST', url })).statusCode).toBe(500);
  expect(await ctx.store.calendarWatch.getEvent(key('soon'))).toMatchObject({ decision: null });
  expect((await app.inject({ method: 'POST', url })).json()).toEqual({ meetingId: 'meeting-3' });
});

it('answers 503 when the bot cannot start, and the meeting can be joined again', async () => {
  const start = vi
    .fn()
    .mockRejectedValueOnce(new OnlineMeetingStartError('Uplink unavailable'))
    .mockResolvedValueOnce({ meetingId: 'meeting-2' });
  const { app } = serve(start);
  const url = `/live-meetings/calendar/${key('soon')}/join`;
  expect((await app.inject({ method: 'POST', url })).statusCode).toBe(503);
  expect((await app.inject({ method: 'POST', url })).json()).toEqual({ meetingId: 'meeting-2' });
});
