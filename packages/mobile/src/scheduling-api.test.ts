import { expect, it, vi } from 'vitest';
import { VerityClient } from './api.js';

const request = {
  id: 'r1',
  sessionId: 's1',
  state: 'open',
  title: 'Intro call',
  durationMinutes: 30,
  addGoogleMeet: true,
  timeZone: 'Europe/Berlin',
  guest: { email: 'anna@example.test', name: null },
  colleagues: [{ email: 'lea@example.test' }],
  closesAt: '2099-11-06T10:00:00.000Z',
  windows: [
    { start: '2099-11-03T13:00:00.000Z', end: '2099-11-03T15:00:00.000Z', state: 'active' },
  ],
  emailSentAt: null,
  booked: null,
  failure: null,
  pendingCleanups: 0,
  link: 'https://x.preview.example.test/?pin=123456',
  createdAt: '2099-10-30T10:00:00.000Z',
};

function client() {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ requests: [request] }), { status: 200 })),
    );
  return {
    fetch,
    api: new VerityClient({ baseUrl: 'https://core.example', fetch, getToken: () => 'token' }),
  };
}

it('reads a session’s requests and the per-user overview, and withdraws by request', async () => {
  const { fetch, api } = client();
  expect(await api.sessionSchedulingRequests('s/1')).toEqual([request]);
  expect(await api.schedulingRequests()).toEqual([request]);
  await api.revokeSchedulingRequest('r1');
  expect(
    fetch.mock.calls.map(([url, init]) => [
      (url as string).replace('https://core.example', ''),
      init?.method,
    ]),
  ).toEqual([
    ['/sessions/s%2F1/scheduling-requests', 'GET'],
    ['/scheduling-requests', 'GET'],
    ['/scheduling-requests/r1/revoke', 'POST'],
  ]);
});
