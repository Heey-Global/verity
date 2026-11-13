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

it.each(['meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hij'])(
  'accepts a pasted meeting link: %s',
  async (meetingUrl) => {
    const service = new AttendeeMeetings({ store: {} as EventStore, ingest: vi.fn() });
    const start = vi
      .spyOn(service, 'start')
      .mockRejectedValue(new OnlineMeetingStartError('ready for startup'));
    const app = Fastify();
    registerAttendeeRoutes(app, service, () => true);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/sessions/session/live-meetings/online',
        payload: { meetingUrl },
      });
      expect(response.statusCode).toBe(503);
      expect(start).toHaveBeenCalledWith(
        'session',
        'https://meet.google.com/abc-defg-hij',
        false,
        undefined,
        expect.any(Object),
      );
    } finally {
      await app.close();
    }
  },
);

// The app shows this inline at the link field, so it needs a code rather than a 500.
it.each(['https://meet.example.com/product', 'http://meet.google.com/abc-defg-hij'])(
  'refuses a link the bot cannot join before preparing anything: %s',
  async (meetingUrl) => {
    const service = new AttendeeMeetings({ store: {} as EventStore, ingest: vi.fn() });
    const start = vi.spyOn(service, 'start');
    const app = Fastify();
    registerAttendeeRoutes(app, service, () => true);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/sessions/session/live-meetings/online',
        payload: { meetingUrl },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'unsupported_meeting_url' });
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it('serves the join status of an online meeting in the session only', async () => {
  const service = new AttendeeMeetings({ store: {} as EventStore, ingest: vi.fn() });
  vi.spyOn(service, 'status').mockImplementation(async (sessionId) =>
    sessionId === 'session' ? { status: 'waiting', reason: null, platform: 'zoom' } : undefined,
  );
  const app = Fastify();
  registerAttendeeRoutes(app, service, () => true);
  const meetingId = '00000000-0000-4000-8000-000000000002';
  try {
    const found = await app.inject({
      method: 'GET',
      url: `/sessions/session/live-meetings/${meetingId}/online/status`,
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({ status: 'waiting', reason: null, platform: 'zoom' });
    const elsewhere = await app.inject({
      method: 'GET',
      url: `/sessions/other/live-meetings/${meetingId}/online/status`,
    });
    expect(elsewhere.statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
