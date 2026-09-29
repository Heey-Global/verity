import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { registerLiveMeetingRoutes } from './live-meeting-routes.js';

let ctx: TestDb;
let app: FastifyInstance;
const ownerToken = 'a'.repeat(64);
const url = '/sessions/session-1/live-meetings/meeting-1';
const meeting = {
  engine: 'fluid-nemotron',
  startedAt: 100,
  endedAt: null,
  state: 'active',
  transcript: 'Live words',
  captureStatus: 'listening',
  ownerToken,
  revision: 1,
};

beforeAll(async () => {
  ctx = await createTestDb();
  app = Fastify();
  registerLiveMeetingRoutes(app, ctx.store);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession({ sessionId: 'session-1', worktree: '/one', model: 'm' });
});

it('publishes transcript and notes without exposing the recorder token', async () => {
  expect((await app.inject({ method: 'PUT', url, payload: meeting })).statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}/notes/note-1`,
        payload: {
          atSeconds: 2,
          text: 'Decision',
          revision: 1,
        },
      })
    ).statusCode,
  ).toBe(200);
  const response = await app.inject({ method: 'GET', url: '/sessions/session-1/live-meetings' });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.meetings).toEqual([expect.objectContaining({ transcript: 'Live words' })]);
  expect(body.notes).toEqual([expect.objectContaining({ text: 'Decision' })]);
  expect(response.body).not.toContain(ownerToken);
  expect(body.meetings[0]).not.toHaveProperty('ownerTokenHash');
});

it('accepts remote pause but lets only the recorder acknowledge it', async () => {
  await app.inject({ method: 'PUT', url, payload: meeting });
  const requested = await app.inject({
    method: 'POST',
    url: `${url}/commands`,
    payload: { action: 'pause' },
  });
  expect(requested.statusCode).toBe(200);
  const commandId = requested.json().commandId;
  const ownerView = await app.inject({
    method: 'GET',
    url: `${url}/commands`,
    headers: {
      'x-meeting-owner-token': ownerToken,
    },
  });
  expect(ownerView.json().commands).toEqual([
    expect.objectContaining({ id: commandId, state: 'pending' }),
  ]);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}/commands/${commandId}`,
        headers: {
          'x-meeting-owner-token': 'wrong-token',
        },
        payload: { state: 'completed', error: null },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}/commands/${commandId}`,
        headers: {
          'x-meeting-owner-token': ownerToken,
        },
        payload: { state: 'completed', error: null },
      })
    ).statusCode,
  ).toBe(200);
  const viewer = await app.inject({ method: 'GET', url: `${url}/commands` });
  expect(viewer.json().commands[0]).toMatchObject({ id: commandId, state: 'completed' });
});

it('reports when the recorder has stopped polling for commands', async () => {
  await app.inject({ method: 'PUT', url, payload: meeting });
  await ctx.db
    .updateTable('live_meetings')
    .set({ recorder_last_seen_at: Date.now() - 30_000 })
    .where('id', '=', 'meeting-1')
    .execute();
  const viewer = await app.inject({ method: 'GET', url: `${url}/commands` });
  expect(viewer.json().recorderOnline).toBe(false);
  const owner = await app.inject({
    method: 'GET',
    url: `${url}/commands`,
    headers: {
      'x-meeting-owner-token': ownerToken,
    },
  });
  expect(owner.json().recorderOnline).toBe(true);
});
