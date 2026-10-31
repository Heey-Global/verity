import { calendarEventKey } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  CalendarEventAlreadyJoinedError,
  joinCalendarMeeting,
  startCalendarMeetingWatcher,
  type CalendarMeetingDeps,
} from './calendar-meeting-watcher.js';
import type { PushSender } from './push-sender.js';

const MIN = 60_000;
const START = Date.parse('2026-11-02T10:00:00Z');

let ctx: TestDb;
let accountId: string;
let watchers: { stop(): Promise<void> }[] = [];
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
});
afterEach(async () => {
  await Promise.all(watchers.map((watcher) => watcher.stop()));
  watchers = [];
});

const meetingEvent = (fields: Record<string, unknown> = {}) => ({
  id: 'weekly',
  etag: '"1"',
  status: 'confirmed',
  summary: 'Weekly sync',
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  start: { dateTime: new Date(START).toISOString() },
  end: { dateTime: new Date(START + 30 * MIN).toISOString() },
  ...fields,
});

async function fixture(options: { autoJoin?: boolean; items?: unknown[] } = {}) {
  await ctx.store.calendarWatch.watch({
    accountId,
    calendarId: 'primary',
    summary: 'Work',
    autoJoin: options.autoJoin ?? false,
  });
  const state = { now: START - 10 * MIN, items: options.items ?? [meetingEvent()] };
  const send = vi.fn<PushSender['send']>(async () => ({
    targets: 1,
    ticketsAccepted: 1,
    ticketErrors: 0,
    receiptsQueued: 0,
    pruned: 0,
    transportErrors: 0,
  }));
  const start = vi.fn(async () => ({ meetingId: 'meeting-1' }));
  const deps: CalendarMeetingDeps = {
    store: {
      calendarWatch: ctx.store.calendarWatch,
      listActiveAdministratorIds: async () => ['admin'],
      listDevicePushTokensForUsers: async () => [
        {
          authTokenId: 'device',
          expoToken: 'ExponentPushToken[x]',
          platform: 'ios',
          createdAt: 0,
          updatedAt: 0,
          userId: 'admin',
        },
      ],
    } as unknown as CalendarMeetingDeps['store'],
    meetings: { start } as unknown as CalendarMeetingDeps['meetings'],
    sender: { send },
    googleAccessToken: async () => 'token',
    fetch: vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ items: state.items }),
    })) as unknown as NonNullable<CalendarMeetingDeps['fetch']>,
    warn: vi.fn(),
    now: () => state.now,
  };
  // Each call is a fresh process: only what the store kept survives.
  const run = async () => {
    const watcher = startCalendarMeetingWatcher(deps);
    watchers.push(watcher);
    await watcher.runOnce();
    await watcher.stop();
  };
  return { state, send, start, deps, run };
}

const categories = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map((call) => (call[0] as { categoryId: string }).categoryId);

it('asks five minutes before the meeting, once, even across restarts', async () => {
  const { state, send, start, run } = await fixture();
  await run();
  expect(send).not.toHaveBeenCalled();
  state.now = START - 5 * MIN;
  await run();
  await run();
  state.now = START - 2 * MIN;
  await run();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({
    title: 'Weekly sync starts in 5 min',
    categoryId: 'MEETING_UPCOMING',
    data: { kind: 'meeting-upcoming', eventKey: calendarEventKey(accountId, 'primary', 'weekly') },
  });
  // Asking is all it does: joining waits for the answer.
  expect(start).not.toHaveBeenCalled();
});

it('asks again when the meeting moves', async () => {
  const { state, send, run } = await fixture();
  state.now = START - 5 * MIN;
  await run();
  state.items = [
    meetingEvent({
      start: { dateTime: new Date(START + 60 * MIN).toISOString() },
      end: { dateTime: new Date(START + 90 * MIN).toISOString() },
    }),
  ];
  await run();
  state.now = START + 56 * MIN;
  await run();
  expect(send).toHaveBeenCalledTimes(2);
});

it('retries a notification the push service did not take', async () => {
  const { state, send, run } = await fixture();
  send.mockResolvedValueOnce({
    targets: 1,
    ticketsAccepted: 0,
    ticketErrors: 0,
    receiptsQueued: 0,
    pruned: 0,
    transportErrors: 1,
  });
  state.now = START - 4 * MIN;
  await run();
  await run();
  expect(send).toHaveBeenCalledTimes(2);
});

it.each([
  [
    'declined',
    { attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }] },
  ],
  ['without a link', { hangoutLink: undefined, description: 'https://example.com/agenda' }],
  ['tentative', { status: 'tentative' }],
])('ignores a %s event', async (_, fields) => {
  const { state, send, run } = await fixture({ items: [meetingEvent(fields)] });
  state.now = START - 5 * MIN;
  await run();
  expect(send).not.toHaveBeenCalled();
});

it('does not announce a meeting that started more than ten minutes ago', async () => {
  const { state, send, run } = await fixture();
  state.now = START + 11 * MIN;
  await run();
  expect(send).not.toHaveBeenCalled();
});

it('joins an automatic calendar at the start, unassigned and only once', async () => {
  const { state, send, start, run } = await fixture({ autoJoin: true });
  state.now = START - 5 * MIN;
  await run();
  expect(start).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  state.now = START;
  await run();
  state.now = START + MIN;
  await run();
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith(
    null,
    'https://meet.google.com/abc-defg-hij',
    true,
    'Weekly sync',
  );
  expect(categories(send)).toEqual(['MEETING_STARTED']);
  expect(send.mock.calls[0]![0]).toMatchObject({
    title: 'Verity joined Weekly sync',
    data: { kind: 'meeting-started', meetingId: 'meeting-1' },
  });
});

// A failed start must not turn into a bot retrying every minute behind the operator's back.
it('does not retry an automatic join that failed', async () => {
  const { state, start, run } = await fixture({ autoJoin: true });
  start.mockRejectedValueOnce(new Error('Uplink unavailable'));
  state.now = START;
  await run();
  await run();
  expect(start).toHaveBeenCalledTimes(1);
  const [event] = await ctx.store.calendarWatch.listEvents();
  expect(event).toMatchObject({ decision: 'failed', meetingId: null });
});

it('joins into a session from the meeting screen without a started notification', async () => {
  const { state, send, start, deps, run } = await fixture();
  await run();
  const key = calendarEventKey(accountId, 'primary', 'weekly');
  state.now = START;
  await expect(joinCalendarMeeting(deps, key, 'session-1')).resolves.toEqual({
    meetingId: 'meeting-1',
  });
  await expect(joinCalendarMeeting(deps, key, null)).rejects.toBeInstanceOf(
    CalendarEventAlreadyJoinedError,
  );
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith('session-1', expect.any(String), true, 'Weekly sync');
  expect(send).not.toHaveBeenCalled();
  // A joined meeting is no longer offered.
  await run();
  expect(send).not.toHaveBeenCalled();
});
