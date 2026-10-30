import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleFetch, GoogleHttpResponse } from './google-drive.js';
import type { PreviewEdgeControl } from './preview-share-manager.js';
import {
  SchedulingService,
  type PrepareSchedulingInput,
  type SchedulingNotification,
} from './scheduling-service.js';
import { schedulingMarkers } from './scheduling-slots.js';

const SCOPES = [
  'calendar.calendarlist.readonly',
  'calendar.events',
  'gmail.readonly',
  'gmail.compose',
  'gmail.settings.basic',
].map((scope) => `https://www.googleapis.com/auth/${scope}`);

interface FakeEvent {
  id: string;
  etag: string;
  status: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { email: string }[];
  transparency?: string;
  extendedProperties?: { private?: Record<string, string> };
}

/** An in-memory Google Calendar with etags, client-chosen ids and conditional writes. */
class FakeCalendar {
  events = new Map<string, FakeEvent>();
  private version = 0;
  failures = 0;
  beforePatch: (() => Promise<void>) | undefined;
  calls: { method: string; path: string; query: URLSearchParams; body?: unknown }[] = [];

  add(event: Omit<FakeEvent, 'etag' | 'status'> & { status?: string }) {
    this.events.set(event.id, { status: 'confirmed', ...event, etag: this.etag() });
  }

  private etag() {
    this.version += 1;
    return `"${String(this.version)}"`;
  }

  fetch: GoogleFetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    this.calls.push({
      method,
      path: parsed.pathname,
      query: parsed.searchParams,
      ...(body ? { body } : {}),
    });
    if (this.failures > 0) {
      this.failures -= 1;
      return respond(503, {});
    }
    const id = decodeURIComponent(parsed.pathname.split('/events')[1]?.replace(/^\//u, '') ?? '');
    if (method === 'GET' && !id) {
      const min = Date.parse(parsed.searchParams.get('timeMin')!);
      const max = Date.parse(parsed.searchParams.get('timeMax')!);
      const property = parsed.searchParams.get('privateExtendedProperty');
      const items = [...this.events.values()].filter((event) => {
        if (event.status === 'cancelled') return false;
        if (property) {
          const [key, value] = property.split('=');
          if (event.extendedProperties?.private?.[key!] !== value) return false;
        }
        const start = Date.parse(event.start.dateTime ?? `${event.start.date!}T00:00:00Z`);
        const end = Date.parse(event.end.dateTime ?? `${event.end.date!}T00:00:00Z`);
        return start < max && end > min;
      });
      return respond(200, { items });
    }
    const existing = this.events.get(id);
    if (method === 'GET') return existing ? respond(200, existing) : respond(404, {});
    if (method === 'POST') {
      const created = body as unknown as FakeEvent;
      if (this.events.has(created.id)) return respond(409, {});
      const event = { ...created, status: 'confirmed', etag: this.etag() };
      this.events.set(event.id, event);
      return respond(200, event);
    }
    if (method === 'PATCH') {
      await this.beforePatch?.();
      const current = this.events.get(id);
      if (!current || current.status === 'cancelled') return respond(404, {});
      if (init?.headers?.['If-Match'] !== current.etag) return respond(412, {});
      const fields = { ...body };
      delete fields.conferenceData;
      const event: FakeEvent = { ...current, ...fields, etag: this.etag() };
      this.events.set(id, event);
      return respond(200, event);
    }
    if (method === 'DELETE') {
      if (!existing || existing.status === 'cancelled') return respond(410, {});
      existing.status = 'cancelled';
      return respond(204, {});
    }
    return respond(400, {});
  };
}

function respond(status: number, body: unknown): Promise<GoogleHttpResponse> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
}

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});

let calendar: FakeCalendar;
let now: Date;
let notifications: SchedulingNotification[];
let sent: { to: string[]; subject: string; body: string }[];
let edge: PreviewEdgeControl & { removed: string[] };
let connected: string[];

function service(overrides: Partial<ConstructorParameters<typeof SchedulingService>[0]> = {}) {
  return new SchedulingService({
    store: {
      scheduling: ctx.store.scheduling,
      getSession: ctx.store.getSession.bind(ctx.store),
      getGoogleServiceCredentials: async () =>
        ({
          refreshToken: 'refresh',
          credentialVersion: 1,
          accountId: 'acct',
          accountEmail: 'holger@example.test',
          scopes: SCOPES,
          source: 'project',
        }) as never,
    },
    googleAccessToken: async () => 'token',
    edge,
    listen: async (id) => `http://127.0.0.1/${id}`,
    connect: async (binding) => {
      connected.push(binding.shareId);
      return { close: () => undefined, waitForDisconnect: () => new Promise(() => undefined) };
    },
    calendarFetch: calendar.fetch,
    sendMail: async (_token, message) => {
      sent.push(message);
      return {};
    },
    notify: async (notification) => {
      notifications.push(notification);
    },
    now: () => now,
    ...overrides,
  });
}

const input = (overrides: Partial<PrepareSchedulingInput> = {}): PrepareSchedulingInput => ({
  sessionId: 's1',
  projectId: null,
  title: 'Intro call',
  durationMinutes: 30,
  windows: [
    { start: '2026-11-03T13:00:00Z', end: '2026-11-03T15:00:00Z' },
    { start: '2026-11-04T09:00:00Z', end: '2026-11-04T10:00:00Z' },
  ],
  guest: { email: 'anna@example.test', name: 'Anna' },
  colleagues: [{ email: 'lea@example.test', name: 'Lea' }],
  addGoogleMeet: true,
  calendarId: 'primary',
  timeZone: 'Europe/Berlin',
  language: 'en',
  bookingDays: 7,
  organizerName: 'Holger',
  ...overrides,
});

async function openRequest(scheduler = service(), overrides: Partial<PrepareSchedulingInput> = {}) {
  const prepared = await scheduler.prepare(input(overrides));
  await scheduler.send(prepared.requestId, 's1', prepared.digest);
  return prepared.requestId;
}

beforeEach(async () => {
  await truncateAll(ctx.db);
  calendar = new FakeCalendar();
  now = new Date('2026-10-30T10:00:00Z');
  notifications = [];
  sent = [];
  connected = [];
  let shares = 0;
  edge = {
    removed: [],
    create: async () => {
      shares += 1;
      return {
        shareId: `share-${String(shares)}`,
        publicOrigin: `https://s${String(shares)}.preview.example.test`,
        edgeUrl: 'wss://edge.example.test',
        connectorToken: 'connector',
        sessionSecret: 'secret',
        expiresAt: new Date(now.getTime() + 30 * 24 * 3600_000),
      };
    },
    remove: async (shareId) => {
      edge.removed.push(shareId);
    },
  };
});

describe('scheduling requests', () => {
  it('previews start times against appointments but not against other holds', async () => {
    calendar.add({
      id: 'board',
      summary: 'Board call',
      start: { dateTime: '2026-11-04T09:30:00Z' },
      end: { dateTime: '2026-11-04T10:30:00Z' },
    });
    calendar.add({
      id: 'other-hold',
      summary: 'Hold · Ben',
      start: { dateTime: '2026-11-03T13:00:00Z' },
      end: { dateTime: '2026-11-03T14:00:00Z' },
      extendedProperties: { private: schedulingMarkers('other', 'hold', 0) },
    });
    const prepared = await service().prepare(input());
    expect(prepared.windows.map((window) => window.startTimes.length)).toEqual([4, 1]);
    expect(prepared.conflicts).toEqual(['Hold · Ben']);
    expect(prepared.state).toBe('draft');
    expect(calendar.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(prepared.closesAt).toBe('2026-11-04T10:00:00.000Z');
  });

  it('creates the holds with colleagues invited, then the link, then the email', async () => {
    const id = await openRequest();
    const holds = [...calendar.events.values()];
    expect(holds).toHaveLength(2);
    expect(holds[0]).toMatchObject({
      attendees: [{ email: 'lea@example.test' }],
      transparency: 'opaque',
      extendedProperties: { private: schedulingMarkers(id, 'hold', 0) },
    });
    expect(calendar.calls.find((call) => call.method === 'POST')?.query.get('sendUpdates')).toBe(
      'all',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['anna@example.test']);
    expect(sent[0]!.body).toMatch(/https:\/\/s1\.preview\.example\.test\/\?pin=\d{6}/u);
    expect(sent[0]!.body).not.toContain('{link}');
    expect(connected).toEqual(['share-1']);
    expect((await ctx.store.scheduling.get(id))?.state).toBe('open');
  });

  it('refuses to send a draft under a digest that does not match it', async () => {
    const scheduler = service();
    const prepared = await scheduler.prepare(input());
    await expect(scheduler.send(prepared.requestId, 's1', 'f'.repeat(64))).rejects.toThrow(
      'differs',
    );
    await expect(
      scheduler.send(prepared.requestId, 'other-session', prepared.digest),
    ).rejects.toThrow('not found');
    expect(calendar.events.size).toBe(0);
  });

  it('reads the offered times live: deleted holds disappear and resized holds change the offer', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler);
    const [tuesday, wednesday] = await ctx.store.scheduling.holds(id);
    const view = await scheduler.view(id);
    expect(view.kind === 'open' && view.slots.length).toBe(6);
    calendar.events.get(wednesday!.eventId)!.status = 'cancelled';
    calendar.events.get(tuesday!.eventId)!.end = { dateTime: '2026-11-03T14:00:00Z' };
    const later = await scheduler.view(id);
    expect(later.kind === 'open' && later.slots.map((slot) => slot.start.toISOString())).toEqual([
      '2026-11-03T13:00:00.000Z',
      '2026-11-03T13:30:00.000Z',
    ]);
  });

  it('books a slot: the hold becomes the appointment and the other holds are removed', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler);
    const [tuesday, wednesday] = await ctx.store.scheduling.holds(id);
    const result = await scheduler.book(id, '2026-11-03T13:30:00Z', 'Looking forward');
    expect(result.kind).toBe('booked');
    const appointment = calendar.events.get(tuesday!.eventId)!;
    expect(appointment).toMatchObject({
      summary: 'Intro call',
      start: { dateTime: '2026-11-03T13:30:00.000Z' },
      end: { dateTime: '2026-11-03T14:00:00.000Z' },
      extendedProperties: { private: schedulingMarkers(id, 'booked', 0) },
    });
    expect(appointment.attendees?.map((attendee) => attendee.email).sort()).toEqual([
      'anna@example.test',
      'lea@example.test',
    ]);
    const patch = calendar.calls.find((call) => call.method === 'PATCH')!;
    expect(patch.query.get('sendUpdates')).toBe('all');
    expect(patch.body).toMatchObject({
      conferenceData: { createRequest: { requestId: `booking-${id}` } },
    });
    expect(notifications.map((n) => n.kind)).toEqual(['booked']);

    await scheduler.runDue();
    expect(calendar.events.get(wednesday!.eventId)?.status).toBe('cancelled');
    expect(calendar.events.get(tuesday!.eventId)?.status).toBe('confirmed');
    expect((await scheduler.view(id)).kind).toBe('booked');
    expect((await scheduler.book(id, '2026-11-04T09:00:00Z')).kind).toBe('closed');
  });

  it('announces a booking once when the guest submits twice', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler);
    const results = await Promise.all([
      scheduler.book(id, '2026-11-03T13:30:00Z'),
      scheduler.book(id, '2026-11-03T13:30:00Z'),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['booked', 'closed']);
    expect(notifications.filter((n) => n.kind === 'booked')).toHaveLength(1);
    await scheduler.view(id);
    expect(notifications.filter((n) => n.kind === 'booked')).toHaveLength(1);
  });

  it('withdrawing during a booking either lets the booking win or stops it before the calendar', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler);
    const [booking, revoke] = await Promise.allSettled([
      scheduler.book(id, '2026-11-03T13:30:00Z'),
      scheduler.revoke(id, 's1'),
    ]);
    const request = await ctx.store.scheduling.get(id);
    const appointments = [...calendar.events.values()].filter(
      (event) =>
        event.status !== 'cancelled' && event.extendedProperties?.private?.verityRole === 'booked',
    );
    if (request?.state === 'booked') {
      expect(booking).toMatchObject({ status: 'fulfilled', value: { kind: 'booked' } });
      expect(revoke.status).toBe('rejected');
      expect(appointments).toHaveLength(1);
    } else {
      expect(request?.state).toBe('revoked');
      expect(appointments).toHaveLength(0);
    }
  });

  it('stops provisioning when the request is withdrawn meanwhile', async () => {
    const prepared = await service().prepare(input());
    await ctx.store.scheduling.approve(prepared.requestId, prepared.digest);
    // Withdraw right after the first hold is created.
    const original = calendar.fetch;
    calendar.fetch = async (url, init) => {
      const response = await original(url, init);
      if (init?.method === 'POST')
        await ctx.store.scheduling.transition(prepared.requestId, ['provisioning'], 'revoked');
      return response;
    };
    const scheduler = service({
      sendMail: async () => {
        throw new Error('must not send');
      },
    });
    await scheduler.runDue();
    expect(sent).toEqual([]);
    expect(edge.removed).toEqual([]);
    expect((await ctx.store.scheduling.get(prepared.requestId))?.hasShare).toBe(false);
    expect([...calendar.events.values()]).toHaveLength(1);
  });

  it('never books the same time twice across overlapping requests', async () => {
    const scheduler = service();
    const anna = await openRequest(scheduler);
    const ben = await openRequest(scheduler, { guest: { email: 'ben@example.test', name: 'Ben' } });
    const results = await Promise.all([
      scheduler.book(anna, '2026-11-03T13:30:00Z'),
      scheduler.book(ben, '2026-11-03T13:30:00Z'),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['booked', 'taken']);
    const appointments = [...calendar.events.values()].filter(
      (event) => event.extendedProperties?.private?.verityRole === 'booked',
    );
    expect(appointments).toHaveLength(1);
    const loser = results.find((result) => result.kind === 'taken');
    expect(
      loser?.kind === 'taken' &&
        loser.model.kind === 'open' &&
        loser.model.slots.some((slot) => slot.start.toISOString() === '2026-11-03T13:30:00.000Z'),
    ).toBe(false);
  });

  it('re-reads and retries once when the hold changed while booking', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler);
    const [tuesday] = await ctx.store.scheduling.holds(id);
    let touched = false;
    calendar.beforePatch = async () => {
      if (touched) return;
      touched = true;
      const event = calendar.events.get(tuesday!.eventId)!;
      calendar.events.set(event.id, { ...event, etag: '"edited"' });
    };
    expect((await scheduler.book(id, '2026-11-03T13:00:00Z')).kind).toBe('booked');
    expect(calendar.calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
  });

  it('finishes a booking whose bookkeeping a crash interrupted instead of offering other holds', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler);
    const [tuesday, wednesday] = await ctx.store.scheduling.holds(id);
    // The calendar was patched, the database never heard about it.
    const event = calendar.events.get(tuesday!.eventId)!;
    calendar.events.set(event.id, {
      ...event,
      start: { dateTime: '2026-11-03T13:00:00Z' },
      end: { dateTime: '2026-11-03T13:30:00Z' },
      extendedProperties: { private: schedulingMarkers(id, 'booked', 0) },
    });
    const view = await service().view(id);
    expect(view.kind).toBe('booked');
    expect((await ctx.store.scheduling.get(id))?.bookedStart?.toISOString()).toBe(
      '2026-11-03T13:00:00.000Z',
    );
    await scheduler.runDue();
    expect(calendar.events.get(wednesday!.eventId)?.status).toBe('cancelled');
    expect(calendar.events.get(tuesday!.eventId)?.status).toBe('confirmed');
  });

  it('closes at the deadline, removes the holds and retires the link at day 30', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler, { bookingDays: 1 });
    now = new Date('2026-10-31T10:00:01Z');
    await scheduler.runDue();
    expect((await ctx.store.scheduling.get(id))?.state).toBe('expired');
    expect([...calendar.events.values()].every((event) => event.status === 'cancelled')).toBe(true);
    expect((await scheduler.view(id)).kind).toBe('closed');
    now = new Date('2026-11-29T10:00:01Z');
    await scheduler.runDue();
    expect(edge.removed).toEqual(['share-1']);
    expect((await ctx.store.scheduling.get(id))?.shareRevokedAt).not.toBeNull();
  });

  it('retries hold removal with backoff and alerts once when it keeps failing', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler);
    await scheduler.revoke(id, 's1');
    calendar.failures = 1_000;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      now = new Date(now.getTime() + 24 * 3600_000);
      await scheduler.runDue();
    }
    expect(notifications.filter((n) => n.kind === 'cleanup_failed')).toHaveLength(1);
    calendar.failures = 0;
    now = new Date(now.getTime() + 24 * 3600_000);
    await scheduler.runDue();
    expect((await ctx.store.scheduling.holds(id)).map((hold) => hold.state)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  it('resumes provisioning after a restart without creating duplicate holds or emails', async () => {
    const prepared = await service().prepare(input());
    // The previous generation approved and created the first hold, then stopped.
    await ctx.store.scheduling.approve(prepared.requestId, prepared.digest);
    const [first] = await ctx.store.scheduling.holds(prepared.requestId);
    calendar.add({
      id: first!.eventId,
      start: { dateTime: '2026-11-03T13:00:00Z' },
      end: { dateTime: '2026-11-03T15:00:00Z' },
      extendedProperties: { private: schedulingMarkers(prepared.requestId, 'hold', 0) },
    });
    const restarted = service();
    await restarted.runDue();
    expect([...calendar.events.values()]).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect((await ctx.store.scheduling.get(prepared.requestId))?.state).toBe('open');
    await restarted.runDue();
    expect(sent).toHaveLength(1);
  });

  it('does not resend an email whose outcome is unknown and tells the operator', async () => {
    const scheduler = service();
    const prepared = await scheduler.prepare(input());
    await ctx.store.scheduling.approve(prepared.requestId, prepared.digest);
    await ctx.store.scheduling.update(prepared.requestId, { attempts: 1 });
    await scheduler.runDue();
    expect(sent).toEqual([]);
    const request = await ctx.store.scheduling.get(prepared.requestId);
    expect(request?.state).toBe('open');
    expect(request?.failure).toMatch(/could not be confirmed/u);
    expect(notifications.map((n) => n.kind)).toEqual(['email_unconfirmed']);
  });

  it('waits for Uplink to reconnect after a restart instead of failing the request', async () => {
    let available = false;
    edge.isAvailable = () => available;
    const scheduler = service();
    const prepared = await scheduler.prepare(input());
    await ctx.store.scheduling.approve(prepared.requestId, prepared.digest);
    await scheduler.runDue();
    expect((await ctx.store.scheduling.get(prepared.requestId))?.state).toBe('provisioning');
    available = true;
    now = new Date(now.getTime() + 2 * 60_000);
    await scheduler.runDue();
    expect((await ctx.store.scheduling.get(prepared.requestId))?.state).toBe('open');
    expect(sent).toHaveLength(1);
  });

  it('pauses a failing link retirement instead of retrying it every pass', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler, { bookingDays: 1 });
    edge.remove = async () => {
      throw new Error('Uplink down');
    };
    now = new Date('2026-11-29T10:00:01Z');
    await scheduler.runDue();
    const paused = await ctx.store.scheduling.get(id);
    expect(paused?.shareRevokedAt).toBeNull();
    expect(paused?.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());
    expect((await ctx.store.scheduling.dueRequests(now)).map((r) => r.id)).not.toContain(id);
  });

  it('fails without a public link before inviting anyone', async () => {
    const scheduler = service({ edge: undefined });
    const prepared = await scheduler.prepare(input());
    await expect(scheduler.send(prepared.requestId, 's1', prepared.digest)).rejects.toThrow(
      'Uplink',
    );
    await scheduler.runDue();
    // Nothing was created: colleagues never get an invitation followed by a cancellation.
    expect(calendar.events.size).toBe(0);
    expect(sent).toEqual([]);
  });

  it('notifies once when no times are left and offers them again when one frees up', async () => {
    const scheduler = service();
    const id = await openRequest(scheduler, {
      windows: [{ start: '2026-11-03T13:00:00Z', end: '2026-11-03T13:30:00Z' }],
    });
    calendar.add({
      id: 'meeting',
      start: { dateTime: '2026-11-03T13:00:00Z' },
      end: { dateTime: '2026-11-03T13:30:00Z' },
    });
    expect((await scheduler.view(id)).kind).toBe('no_slots');
    expect((await scheduler.view(id)).kind).toBe('no_slots');
    expect(notifications.filter((n) => n.kind === 'no_slots')).toHaveLength(1);
    calendar.events.get('meeting')!.status = 'cancelled';
    expect((await scheduler.view(id)).kind).toBe('open');
  });

  it('withdraws every open request when online sharing is turned off', async () => {
    let disable: (() => void) | undefined;
    edge.onSharingDisabled = (listener) => {
      disable = listener;
      return () => undefined;
    };
    const scheduler = service();
    const id = await openRequest(scheduler);
    disable!();
    await vi.waitFor(async () => {
      expect((await ctx.store.scheduling.get(id))?.state).toBe('revoked');
    });
    await vi.waitFor(() => expect(edge.removed).toEqual(['share-1']));
  });
});
