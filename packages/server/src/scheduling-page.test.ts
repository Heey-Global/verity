import { request as httpRequest } from 'node:http';
import type { SchedulingRequest } from '@verity/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderSchedulingPage,
  SchedulingPageListeners,
  type SchedulingPageBackend,
} from './scheduling-page.js';
import type { SchedulingPageModel } from './scheduling-service.js';

const request = (overrides: Partial<SchedulingRequest> = {}): SchedulingRequest => ({
  id: 'r1',
  sessionId: 's1',
  projectId: null,
  googleAccountId: 'acct',
  calendarId: 'primary',
  timeZone: 'Europe/Berlin',
  language: 'en',
  title: 'Intro call <Berger>',
  durationMinutes: 30,
  addMeet: true,
  organizerName: 'Sam',
  organizerEmail: 'sam@example.test',
  guestEmail: 'anna@example.test',
  guestName: 'Anna',
  colleagues: [{ email: 'lea@example.test', name: 'Lea' }],
  emailSubject: 'Pick a time',
  emailBody: 'Hi {link}',
  state: 'open',
  failure: null,
  closesAt: new Date('2099-11-06T10:00:00Z'),
  linkExpiresAt: null,
  approvedAt: null,
  approvalDigest: null,
  senderAccountId: null,
  hasShare: true,
  shareRevokedAt: null,
  emailSentAt: null,
  bookedEventId: null,
  bookedStart: null,
  bookedEnd: null,
  guestNote: null,
  notifiedNoSlotsAt: null,
  attempts: 0,
  nextAttemptAt: null,
  revision: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});
const slot = (iso: string) => ({
  start: new Date(iso),
  end: new Date(Date.parse(iso) + 30 * 60_000),
  position: 0,
});

describe('booking page rendering', () => {
  it('groups start times by day in the organizer’s zone and escapes request text', () => {
    const page = renderSchedulingPage(
      {
        kind: 'open',
        request: request(),
        slots: [slot('2099-11-03T13:00:00Z'), slot('2099-11-03T13:30:00Z')],
      },
      { nonce: 'n' },
    );
    expect(page.status).toBe(200);
    expect(page.html).toContain('Intro call &lt;Berger&gt;');
    expect(page.html).not.toContain('<Berger>');
    expect(page.html).toContain('>14:00</a>');
    expect(page.html).toContain('/confirm?start=2099-11-03T13%3A00%3A00.000Z');
    expect(page.html).toContain('http-equiv="refresh" content="60"');
  });

  it('shows the visitor’s chosen time zone only when it is a real one', () => {
    const model: SchedulingPageModel = {
      kind: 'open',
      request: request(),
      slots: [slot('2099-11-03T13:00:00Z')],
    };
    expect(renderSchedulingPage(model, { nonce: 'n', zone: 'America/New_York' }).html).toContain(
      '>08:00</a>',
    );
    expect(renderSchedulingPage(model, { nonce: 'n', zone: 'Mars/Base' }).html).toContain(
      '>14:00</a>',
    );
  });

  it('renders the German page for German requests', () => {
    const page = renderSchedulingPage(
      { kind: 'no_slots', request: request({ language: 'de' }) },
      { nonce: 'n' },
    );
    expect(page.html).toContain('lang="de"');
    expect(page.html).toContain('Aktuell sind keine Termine frei');
  });

  it.each([
    [request({ state: 'expired' }), 'This request has expired'],
    [request({ state: 'revoked' }), 'This request was withdrawn'],
  ])('explains a closed request', (closed, title) => {
    expect(
      renderSchedulingPage({ kind: 'closed', request: closed }, { nonce: 'n' }).html,
    ).toContain(title);
  });

  it('never offers booking while the calendar cannot be read', () => {
    const page = renderSchedulingPage({ kind: 'unavailable', request: request() }, { nonce: 'n' });
    expect(page.html).toContain('We can’t check the calendar right now');
    expect(page.html).not.toContain('/confirm');
  });
});

describe('booking page listener', () => {
  const listeners: SchedulingPageListeners[] = [];
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  });

  async function serve(backend: SchedulingPageBackend) {
    const listener = new SchedulingPageListeners(backend);
    listeners.push(listener);
    return listener.listen('r1');
  }

  function call(origin: string, method: string, path: string, body?: string) {
    return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = httpRequest(
          `${origin}${path}`,
          { method, headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {} },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
                headers: res.headers,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      },
    );
  }

  it('only reads on GET and books only on an explicit POST', async () => {
    const book = vi.fn().mockResolvedValue({
      kind: 'booked',
      request: request({
        state: 'booked',
        bookedStart: new Date('2099-11-03T13:00:00Z'),
        bookedEnd: new Date('2099-11-03T13:30:00Z'),
      }),
    });
    const origin = await serve({
      view: async () => ({
        kind: 'open',
        request: request(),
        slots: [slot('2099-11-03T13:00:00Z')],
      }),
      book,
    });
    const confirm = await call(origin, 'GET', '/confirm?start=2099-11-03T13%3A00%3A00.000Z');
    expect(confirm.status).toBe(200);
    expect(confirm.body).toContain('<form method="post" action="/book">');
    expect(String(confirm.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(book).not.toHaveBeenCalled();
    const booked = await call(
      origin,
      'POST',
      '/book',
      'start=2099-11-03T13%3A00%3A00.000Z&note=Hello',
    );
    expect(booked.body).toContain('You’re booked');
    expect(book).toHaveBeenCalledWith('r1', '2099-11-03T13:00:00.000Z', 'Hello');
  });

  it('refuses a post from a browser on another origin', async () => {
    const book = vi.fn();
    const origin = await serve({
      view: async () => ({ kind: 'open', request: request(), slots: [] }),
      book,
      publicOrigin: async () => 'https://x.preview.example.test',
    });
    const response = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${origin}/book`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://rebound.example.test',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('start=2099-11-03T13%3A00%3A00.000Z');
    });
    expect(response).toBe(403);
    expect(book).not.toHaveBeenCalled();
  });

  it('answers a taken time with the remaining times and a hint', async () => {
    const origin = await serve({
      view: async () => ({ kind: 'open', request: request(), slots: [] }),
      book: async () => ({
        kind: 'taken',
        model: { kind: 'open', request: request(), slots: [slot('2099-11-03T14:00:00Z')] },
      }),
    });
    const response = await call(origin, 'POST', '/book', 'start=2099-11-03T13%3A00%3A00.000Z');
    expect(response.body).toContain('was just booked');
    expect(response.body).toContain('>15:00</a>');
  });

  it('limits booking attempts and rejects oversized or malformed forms', async () => {
    const origin = await serve({
      view: async () => ({ kind: 'unavailable', request: request() }),
      book: async () => ({
        kind: 'unavailable',
        model: { kind: 'unavailable', request: request() },
      }),
    });
    expect((await call(origin, 'POST', '/book', 'start=nope')).status).toBe(400);
    expect((await call(origin, 'POST', '/book', `start=${'x'.repeat(20_000)}`)).status).toBe(400);
    for (let i = 0; i < 18; i += 1)
      await call(origin, 'POST', '/book', 'start=2099-11-03T13%3A00%3A00.000Z');
    expect((await call(origin, 'POST', '/book', 'start=2099-11-03T13%3A00%3A00.000Z')).status).toBe(
      429,
    );
    expect((await call(origin, 'DELETE', '/')).status).toBe(405);
  });
});
