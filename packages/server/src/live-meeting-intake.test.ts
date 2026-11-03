import type { EventStore } from '@verity/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import {
  UnassignedMeetingNotFoundError,
  type UnassignedOnlineMeeting,
} from './attendee-meetings.js';
import {
  DEFAULT_UNASSIGNED_MEETING_RETENTION_DAYS,
  assignedSessionId,
  discardExpiredUnassignedMeetings,
  registerLiveMeetingIntakeRoutes,
} from './live-meeting-intake.js';
import type { SpawnSession } from './session-create-route.js';

const MEETING = '11111111-1111-4111-8111-111111111111';
const DAY = 24 * 60 * 60 * 1000;

const unassigned = (
  id: string,
  endedAt: number | null,
  title: string | null = 'Design review',
): UnassignedOnlineMeeting => ({
  id,
  title,
  startedAt: 1_000,
  endedAt,
  state: endedAt === null ? 'active' : 'ended',
  captureStatus: 'listening',
  people: 2,
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function fixture(options: { retention?: number | null; meetings?: UnassignedOnlineMeeting[] }) {
  const meetings = {
    list: options.meetings ?? [unassigned(MEETING, null)],
    unassigned: vi.fn(async () => meetings.list),
    assign: vi.fn(async (id: string) => {
      if (!meetings.list.some((item) => item.id === id)) throw new UnassignedMeetingNotFoundError();
      meetings.list = meetings.list.filter((item) => item.id !== id);
      return { meetingId: id };
    }),
    discard: vi.fn(async (id: string) => {
      const known = meetings.list.some((item) => item.id === id);
      meetings.list = meetings.list.filter((item) => item.id !== id);
      return known;
    }),
  };
  const store = {
    getVeritySettingsRaw: async () => ({
      unassignedMeetingRetentionDays: options.retention ?? null,
    }),
    isActiveAdministrator: async (id: string) => id === 'admin',
    getSession: async (id: string) =>
      id.startsWith('missing')
        ? undefined
        : { sessionId: id, name: `Name of ${id}`, projectId: 'p' },
    liveMeetings: {
      running: async () => [
        {
          sessionId: 'readable',
          id: 'r',
          title: 'Standup',
          engine: 'attendee',
          startedAt: 5,
          state: 'active',
          captureStatus: 'listening',
        },
        {
          sessionId: 'hidden',
          id: 'h',
          title: null,
          engine: 'apple-speech',
          startedAt: 6,
          state: 'active',
          captureStatus: 'listening',
        },
      ],
    },
  } as unknown as EventStore;
  const spawn = vi.fn<SpawnSession>(async (body) => ({
    statusCode: 200,
    result: { sessionId: body.sessionId! },
  }));
  return { meetings, store, spawn };
}

async function serve(f: ReturnType<typeof fixture>) {
  app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (req) => {
    const header = req.headers['x-test-user'];
    req.localUserId = typeof header === 'string' ? header : null;
  });
  registerLiveMeetingIntakeRoutes(app, {
    store: f.store,
    meetings: f.meetings,
    spawn: f.spawn,
    canReadSession: async (userId, sessionId) => userId === undefined || sessionId === 'readable',
    log: { warn: vi.fn() },
  });
  await app.ready();
  return app;
}

it('shows each user the running meetings they may read, and unassigned ones to administrators', async () => {
  const server = await serve(fixture({}));
  const member = await server.inject({
    url: '/live-meetings/active',
    headers: { 'x-test-user': 'member' },
  });
  expect(member.json()).toEqual({
    running: [
      expect.objectContaining({ id: 'r', sessionId: 'readable', sessionName: 'Name of readable' }),
    ],
    unassigned: [],
    retentionDays: DEFAULT_UNASSIGNED_MEETING_RETENTION_DAYS,
  });
  const admin = await server.inject({
    url: '/live-meetings/active',
    headers: { 'x-test-user': 'admin' },
  });
  expect(admin.json().unassigned).toEqual([expect.objectContaining({ id: MEETING })]);
});

it('assigns to a project through a session named after the meeting, idempotently per project', async () => {
  const f = fixture({});
  const server = await serve(f);
  const response = await server.inject({
    method: 'POST',
    url: `/live-meetings/unassigned/${MEETING}/assign`,
    payload: { projectId: 'website' },
  });
  const sessionId = assignedSessionId(MEETING, 'website');
  expect(response.json()).toEqual({ sessionId, meetingId: MEETING });
  expect(f.spawn).toHaveBeenCalledWith(
    { projectId: 'website', sessionId, name: 'Design review' },
    expect.anything(),
  );
  expect(f.meetings.assign).toHaveBeenCalledWith(MEETING, sessionId);
  // A retry must land on the session the first attempt created; another project must not.
  expect(assignedSessionId(MEETING, 'website')).toBe(sessionId);
  expect(assignedSessionId(MEETING, 'org-verity')).not.toBe(sessionId);
  const again = await server.inject({
    method: 'POST',
    url: `/live-meetings/unassigned/${MEETING}/assign`,
    payload: { projectId: 'website' },
  });
  expect(again.statusCode).toBe(404);
});

it('continues a meeting in an existing session without creating one', async () => {
  const f = fixture({ meetings: [unassigned(MEETING, null, null)] });
  const server = await serve(f);
  const missing = await server.inject({
    method: 'POST',
    url: `/live-meetings/unassigned/${MEETING}/assign`,
    payload: { sessionId: 'missing-session' },
  });
  expect(missing.statusCode).toBe(404);
  const response = await server.inject({
    method: 'POST',
    url: `/live-meetings/unassigned/${MEETING}/assign`,
    payload: { sessionId: 'existing' },
  });
  expect(response.json()).toEqual({ sessionId: 'existing', meetingId: MEETING });
  expect(f.spawn).not.toHaveBeenCalled();
  const both = await server.inject({
    method: 'POST',
    url: `/live-meetings/unassigned/${MEETING}/assign`,
    payload: { sessionId: 'existing', projectId: 'website' },
  });
  // Both targets at once is ambiguous; the body schema refuses it before anything runs.
  expect(both.statusCode).toBeGreaterThanOrEqual(400);
  expect(f.meetings.assign).toHaveBeenCalledTimes(1);
});

it('reports a project that cannot take a session yet instead of assigning', async () => {
  const f = fixture({});
  f.spawn.mockResolvedValueOnce({
    statusCode: 202,
    result: { project: {} as never, awaitingProvisioning: true },
  });
  const server = await serve(f);
  const response = await server.inject({
    method: 'POST',
    url: `/live-meetings/unassigned/${MEETING}/assign`,
    payload: { projectId: 'sleeping' },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain('starting');
  expect(f.meetings.assign).not.toHaveBeenCalled();
});

it('discards an unassigned meeting once', async () => {
  const f = fixture({});
  const server = await serve(f);
  const first = await server.inject({
    method: 'DELETE',
    url: `/live-meetings/unassigned/${MEETING}`,
  });
  expect(first.json()).toEqual({ discarded: true });
  const second = await server.inject({
    method: 'DELETE',
    url: `/live-meetings/unassigned/${MEETING}`,
  });
  expect(second.statusCode).toBe(404);
});

it('discards unassigned meetings only after the retention since their end', async () => {
  const now = 100 * DAY;
  const f = fixture({
    retention: 3,
    meetings: [
      unassigned('running', null),
      unassigned('recent', now - 2 * DAY),
      unassigned('due', now - 3 * DAY),
      unassigned('old', now - 30 * DAY),
    ],
  });
  const discarded = await discardExpiredUnassignedMeetings({
    store: f.store,
    meetings: f.meetings,
    log: { warn: vi.fn() },
    now,
  });
  expect(discarded).toBe(2);
  expect(f.meetings.discard.mock.calls.map(([id]) => id)).toEqual(['due', 'old']);
  expect(f.meetings.list.map((item) => item.id)).toEqual(['running', 'recent']);
});
