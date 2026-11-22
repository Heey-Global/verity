import { liveResourceInterval } from '@verity/events';
import type { ProjectInquiry, SessionCoordinationEntry } from '@verity/store';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import {
  COLLABORATION_EARLIER_MS,
  COLLABORATION_RECENT_MS,
  registerSessionCollaborationRoutes,
  type CollaborationEntry,
  type SessionCollaborationDeps,
} from './session-collaboration-routes.js';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const inquiry = (overrides: Partial<ProjectInquiry>): ProjectInquiry => ({
  id: 'inquiry',
  sourceSessionId: 'self',
  targetSessionId: 'peer',
  sourceProjectId: 'home',
  targetProjectId: 'other',
  title: 'Question',
  body: 'Body',
  kind: 'question',
  status: 'approved',
  createdAt: new Date(NOW - HOUR).toISOString(),
  answer: null,
  userId: 'alice',
  decidedBy: null,
  humanApproved: true,
  ...overrides,
});

const request = (overrides: Partial<SessionCoordinationEntry>): SessionCoordinationEntry => ({
  sourceSessionId: 'self',
  targetSessionId: 'peer',
  phase: 'delivered',
  createdSession: false,
  linkedAt: new Date(NOW - HOUR),
  ...overrides,
});

function setup(input: {
  requests?: SessionCoordinationEntry[];
  inquiries?: ProjectInquiry[];
  pending?: Array<{ targetSessionId: string; approvedAt: Date | null }>;
  busy?: string[];
  lastEvent?: Record<string, number>;
  denied?: string[];
  sessions?: Record<string, string>;
}) {
  const sessions: Record<string, string> = {
    self: 'home',
    peer: 'other',
    second: 'other',
    hidden: 'secret',
    ...input.sessions,
  };
  const deps: SessionCollaborationDeps = {
    now: () => NOW,
    busy: (id) => input.busy?.includes(id) ?? false,
    authorized: async (_userId, projectId) => !(input.denied ?? []).includes(projectId),
    store: {
      getSession: async (id: string) =>
        sessions[id] === undefined
          ? undefined
          : ({ sessionId: id, projectId: sessions[id], name: `${id} name` } as never),
      listProjects: async () =>
        ['home', 'other', 'secret'].map((id) => ({ id, name: `${id} project` })) as never,
      getEventsBeforeSeq: (async (id: string) => ({
        events: input.lastEvent?.[id] === undefined ? [] : [{ ts: input.lastEvent[id] }],
        hasMore: false,
      })) as never,
      listPendingSessionLinkMessages: (async () => input.pending ?? []) as never,
      projectInquiries: { list: async () => input.inquiries ?? [] } as never,
      sessionCoordination: { listForSession: async () => input.requests ?? [] } as never,
    },
  };
  const app = Fastify();
  registerSessionCollaborationRoutes(app, deps);
  return {
    app,
    read: async (id = 'self') => {
      const response = await app.inject({ method: 'GET', url: `/sessions/${id}/collaboration` });
      return {
        status: response.statusCode,
        body: response.json<{ entries: CollaborationEntry[] }>(),
      };
    },
  };
}

it('names the direction from who asked and whether a session was started', async () => {
  const { app, read } = setup({
    requests: [
      request({ targetSessionId: 'peer' }),
      request({ targetSessionId: 'second', createdSession: true }),
      request({ sourceSessionId: 'hidden', targetSessionId: 'self' }),
    ],
    sessions: { hidden: 'other' },
    busy: ['peer', 'second', 'hidden'],
  });
  const { body } = await read();
  expect(
    Object.fromEntries(body.entries.map((entry) => [entry.sessionId, entry.direction])),
  ).toEqual({ peer: 'asked', second: 'handedOver', hidden: 'askedBy' });
  expect(body.entries[0]).toMatchObject({
    sessionName: 'peer name',
    projectId: 'other',
    projectName: 'other project',
    state: 'working',
    section: 'current',
  });
  await app.close();
});

it('derives each state and puts what waits for the person first', async () => {
  const { app, read } = setup({
    inquiries: [
      inquiry({ targetSessionId: 'peer', status: 'answered' }),
      inquiry({ id: 'b', targetSessionId: 'second', status: 'pending' }),
    ],
    requests: [request({ targetSessionId: 'hidden', linkedAt: new Date(NOW - 2 * HOUR) })],
    sessions: { hidden: 'other' },
  });
  const states = (await read()).body.entries.map((entry) => [entry.sessionId, entry.state]);
  expect(states).toEqual([
    ['second', 'waitingForYou'],
    ['peer', 'answer'],
    ['hidden', 'done'],
  ]);
  await app.close();
});

it('marks a message held on this session’s card as waiting, even while the peer works', async () => {
  const { app, read } = setup({
    requests: [request({ phase: 'linked' })],
    pending: [{ targetSessionId: 'peer', approvedAt: null }],
    busy: ['peer'],
  });
  expect((await read()).body.entries[0].state).toBe('waitingForYou');
  await app.close();
});

it('an answer on the asked side is simply done', async () => {
  const { app, read } = setup({
    inquiries: [inquiry({ sourceSessionId: 'peer', targetSessionId: 'self', status: 'answered' })],
  });
  expect((await read()).body.entries[0]).toMatchObject({ direction: 'askedBy', state: 'done' });
  await app.close();
});

it('keeps finished work in the row for a day, under Earlier for a week, then drops it', async () => {
  const at = (age: number) => new Date(NOW - age);
  const { app, read } = setup({
    requests: [
      request({ targetSessionId: 'peer', linkedAt: at(COLLABORATION_RECENT_MS - HOUR) }),
      request({ targetSessionId: 'second', linkedAt: at(COLLABORATION_RECENT_MS + HOUR) }),
      request({ targetSessionId: 'hidden', linkedAt: at(COLLABORATION_EARLIER_MS + HOUR) }),
    ],
    inquiries: [
      inquiry({
        id: 'old-answer',
        targetSessionId: 'old',
        status: 'answered',
        createdAt: at(COLLABORATION_RECENT_MS + HOUR).toISOString(),
      }),
    ],
    sessions: { hidden: 'other', old: 'other' },
  });
  const sections = (await read()).body.entries.map((entry) => [
    entry.sessionId,
    entry.state,
    entry.section,
  ]);
  expect(sections).toEqual([
    ['peer', 'done', 'current'],
    ['second', 'done', 'earlier'],
    // An answer older than a day is no longer news.
    ['old', 'done', 'earlier'],
  ]);
  await app.close();
});

it('counts the peer’s latest activity, not only when the work began', async () => {
  const { app, read } = setup({
    requests: [request({ linkedAt: new Date(NOW - COLLABORATION_EARLIER_MS - HOUR) })],
    lastEvent: { peer: NOW - HOUR },
  });
  expect((await read()).body.entries[0]).toMatchObject({
    section: 'current',
    updatedAt: new Date(NOW - HOUR).toISOString(),
  });
  await app.close();
});

it('merges an inquiry and its link into one entry per peer', async () => {
  const { app, read } = setup({
    requests: [request({})],
    inquiries: [inquiry({ status: 'queued' })],
  });
  const { entries } = (await read()).body;
  expect(entries).toHaveLength(1);
  expect(entries[0].state).toBe('working');
  await app.close();
});

it('hides peers in projects the person may not work in and deleted peers', async () => {
  const { app, read } = setup({
    requests: [request({ targetSessionId: 'hidden' }), request({ targetSessionId: 'gone' })],
    denied: ['secret'],
  });
  expect((await read()).body.entries).toEqual([]);
  await app.close();
});

it('answers 404 for an unknown session or one in a project the person may not use', async () => {
  const { app, read } = setup({ denied: ['home'] });
  expect((await read('missing')).status).toBe(404);
  expect((await read('self')).status).toBe(404);
  await app.close();
});

// The app refreshes the row through a live watcher; a path the watcher may not
// observe leaves the row frozen at whatever it showed when the session opened.
it('is a resource live clients may observe', () => {
  expect(liveResourceInterval('/sessions/s/collaboration')).toBeDefined();
});
