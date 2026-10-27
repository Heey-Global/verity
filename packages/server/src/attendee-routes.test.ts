import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { AttendeeMeetings, OnlineMeetingStartError } from './attendee-meetings.js';
import { registerAttendeeRoutes } from './attendee-routes.js';

it('returns actionable startup guidance when no Uplink webhook authority is configured', async () => {
  const service = new AttendeeMeetings({ store: {} as EventStore, ingest: vi.fn() });
  const app = Fastify();
  registerAttendeeRoutes(app, service, () => true);
  await service.open();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/session/live-meetings/online',
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: expect.stringContaining('Check Uplink / Online Sharing and retry.'),
    });
  } finally {
    await app.close();
    await service.close();
  }
});

it('exposes only explicitly safe startup errors', async () => {
  const service = new AttendeeMeetings({ store: {} as EventStore, ingest: vi.fn() });
  const start = vi.spyOn(service, 'start');
  const app = Fastify();
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(500).send({ error: 'internal error' }),
  );
  registerAttendeeRoutes(app, service, () => true);
  const request = {
    method: 'POST' as const,
    url: '/sessions/session/live-meetings/online',
    payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij' },
  };
  try {
    start.mockRejectedValueOnce(new OnlineMeetingStartError('Check Uplink and retry.'));
    const unavailable = await app.inject(request);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: 'Check Uplink and retry.' });
    start.mockRejectedValueOnce(new Error('private internal detail'));
    const unexpected = await app.inject(request);
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json()).toEqual({ error: 'internal error' });
  } finally {
    await app.close();
  }
});
