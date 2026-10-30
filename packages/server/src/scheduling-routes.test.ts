import type { EventStore, SchedulingRequest } from '@verity/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSchedulingRoutes } from './scheduling-routes.js';
import type { SchedulingService } from './scheduling-service.js';

const request = (id: string, projectId: string | null): SchedulingRequest =>
  ({
    id,
    sessionId: 'deleted-session',
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

async function serve() {
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
        listRecent: async () => stored,
        get: async (id: string) => stored.find((r) => r.id === id),
        holds: async () => [],
      },
      hasProjectPermission: async (userId: string, projectId: string, permission: string) =>
        userId === 'member' && projectId === 'mine' && permission === 'execute',
      isActiveAdministrator: async (userId: string) => userId === 'admin',
      getSession: async () => undefined,
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
});
