import type { EventStore, SchedulingRequest } from '@verity/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSchedulingRoutes } from './scheduling-routes.js';
import type { SchedulingService } from './scheduling-service.js';

const request = (
  id: string,
  projectId: string | null,
  sessionId = 'deleted-session',
): SchedulingRequest =>
  ({
    id,
    sessionId,
    projectId,
    state: 'open',
    title: 'Intro call',
    durationMinutes: 30,
    addMeet: false,
    timeZone: 'Europe/Berlin',
    guestEmail: 'anna@example.test',
    guestName: 'Anna',
    colleagues: [],
    closesAt: new Date('2099-11-06T10:00:00Z'),
    emailSentAt: null,
    bookedStart: null,
    bookedEnd: null,
    failure: null,
    createdAt: new Date('2099-10-30T10:00:00Z'),
  }) as unknown as SchedulingRequest;

const stored = [
  request('11111111-1111-4111-8111-111111111111', 'mine'),
  request('22222222-2222-4222-8222-222222222222', 'theirs'),
  request('33333333-3333-4333-8333-333333333333', null),
];

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

let assistant = { enabled: true, session_id: 'assistant' as string | null };
const grants = [
  { project_id: 'mine', mode: 'tasks' },
  { project_id: 'theirs', mode: 'off' },
  { project_id: 'archived', mode: 'tasks' },
];

async function serve(extra: SchedulingRequest[] = []) {
  const all = [...stored, ...extra];
  const revoke = vi.fn(async (id: string) => stored.find((r) => r.id === id)!);
  app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (req) => {
    const header = req.headers['x-test-user'];
    req.localUserId = typeof header === 'string' ? header : null;
  });
  registerSchedulingRoutes(app, {
    eventStore: {
      scheduling: {
        listRecent: async () => all,
        get: async (id: string) => all.find((r) => r.id === id),
        holds: async () => [],
      },
      assistant: { settings: async () => assistant, grants: async () => grants },
      getProject: async (id: string) => ({ id, hiddenAt: null, archived: id === 'archived' }),
      hasProjectPermission: async (userId: string, projectId: string, permission: string) =>
        userId === 'member' &&
        ['mine', 'control', 'archived'].includes(projectId) &&
        permission === 'execute',
      isActiveAdministrator: async (userId: string) => userId === 'admin',
      getSession: async (id: string) => (id === 'assistant' ? { id } : undefined),
    } as unknown as EventStore,
    service: {
      publicLink: async () => 'https://x.preview.example.test/?pin=123456',
      revoke,
    } as unknown as SchedulingService,
  });
  return { revoke };
}

describe('scheduling request routes', () => {
  it('shows each user the requests of projects they may run, including deleted chats', async () => {
    await serve();
    const ids = async (user?: string) =>
      (
        await app!.inject({
          method: 'GET',
          url: '/scheduling-requests',
          headers: user ? { 'x-test-user': user } : {},
        })
      )
        .json<{ requests: { id: string }[] }>()
        .requests.map((r) => r.id);
    expect(await ids('member')).toEqual([stored[0]!.id]);
    expect(await ids('admin')).toEqual([stored[2]!.id]);
    expect(await ids()).toEqual(stored.map((r) => r.id));
  });

  it('lets a user withdraw only requests they may see, independently of the chat', async () => {
    const { revoke } = await serve();
    const withdraw = (id: string) =>
      app!.inject({
        method: 'POST',
        url: `/scheduling-requests/${id}/revoke`,
        headers: { 'x-test-user': 'member' },
      });
    expect((await withdraw(stored[1]!.id)).statusCode).toBe(404);
    expect(revoke).not.toHaveBeenCalled();
    expect((await withdraw(stored[0]!.id)).statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith(stored[0]!.id);
  });

  it('gives the assistant the requests of granted projects and its own, as far as the user may see', async () => {
    const own = request('44444444-4444-4444-8444-444444444444', 'control', 'assistant');
    const elsewhere = request('55555555-5555-4555-8555-555555555555', 'control', 'other');
    const archived = request('66666666-6666-4666-8666-666666666666', 'archived');
    // Settled requests would still carry their guest link to the app for nothing.
    const booked = {
      ...request('77777777-7777-4777-8777-777777777777', 'mine'),
      state: 'booked',
    } as SchedulingRequest;
    await serve([own, elsewhere, archived, booked]);
    const overview = async (user: string) =>
      (
        await app!.inject({
          method: 'GET',
          url: '/assistant/scheduling-requests',
          headers: { 'x-test-user': user },
        })
      ).json<{
        assistantSessionId: string | null;
        requests: { id: string; projectId: string; sessionAvailable: boolean }[];
      }>();
    const member = await overview('member');
    expect(member.assistantSessionId).toBe('assistant');
    // 'theirs' is not granted, the null-project request needs an administrator, and a request
    // from another Control session is neither granted nor the assistant's own. An archived
    // project keeps its grant but drops out, as it does for the assistant's own tool. A booked
    // request is no longer open.
    expect(member.requests.map((r) => r.id)).toEqual([stored[0]!.id, own.id]);
    expect(member.requests[0]!.projectId).toBe('mine');
    // The first request's chat was deleted; the app must not link to it.
    expect(member.requests.map((r) => r.sessionAvailable)).toEqual([false, true]);
    expect((await overview('stranger')).requests).toEqual([]);
    // Every chat asks with its own id; any other chat gets an empty answer without the work.
    const other = await app!.inject({
      method: 'GET',
      url: '/assistant/scheduling-requests?sessionId=other',
      headers: { 'x-test-user': 'member' },
    });
    expect(other.json()).toEqual({ assistantSessionId: 'assistant', requests: [] });
  });

  it('shows no overview while the assistant is switched off', async () => {
    assistant = { enabled: false, session_id: 'assistant' };
    try {
      await serve();
      const response = await app!.inject({
        method: 'GET',
        url: '/assistant/scheduling-requests',
        headers: { 'x-test-user': 'member' },
      });
      expect(response.json()).toEqual({ assistantSessionId: null, requests: [] });
    } finally {
      assistant = { enabled: true, session_id: 'assistant' };
    }
  });
});
