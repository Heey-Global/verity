import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthTokenRegistry, type AuthTokenRegistry } from './auth.js';
import type { PushSender } from './push-sender.js';
import { buildServer } from './server.js';

describe('POST /devices/:id/push-token', () => {
  let ctx: TestDb;
  let app: FastifyInstance;
  let registry: AuthTokenRegistry;

  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => {
    await app?.close();
    await ctx.close();
  });
  beforeEach(async () => {
    if (app !== undefined) await app.close();
    await truncateAll(ctx.db);
    registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
      authRegistry: registry,
      pushEnabled: true,
    });
  });

  async function pairedDevice(): Promise<{ id: string; token: string }> {
    return registry.mint('iPhone');
  }

  it('registers the authenticated device and reports the capability in healthz', async () => {
    const device = await pairedDevice();
    const res = await app.inject({
      method: 'POST',
      url: `/devices/${device.id}/push-token`,
      headers: { authorization: `Bearer ${device.token}` },
      payload: { expoToken: 'ExpoPushToken[abc_123-XYZ]', platform: 'ios' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ registered: true });
    expect(await ctx.store.getDevicePushToken(device.id)).toMatchObject({
      expoToken: 'ExpoPushToken[abc_123-XYZ]',
      platform: 'ios',
    });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().pushEnabled).toBe(true);
  });

  it('rejects a valid device trying to register for a different id', async () => {
    const device = await pairedDevice();
    const res = await app.inject({
      method: 'POST',
      url: '/devices/someone-else/push-token',
      headers: { authorization: `Bearer ${device.token}` },
      payload: { expoToken: 'ExpoPushToken[abc]', platform: 'ios' },
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.store.listDevicePushTokens()).toEqual([]);
  });

  it('requires a valid bearer and an enabled auth registry', async () => {
    const device = await pairedDevice();
    for (const authorization of [undefined, 'Bearer not-valid']) {
      const res = await app.inject({
        method: 'POST',
        url: `/devices/${device.id}/push-token`,
        ...(authorization === undefined ? {} : { headers: { authorization } }),
        payload: { expoToken: 'ExpoPushToken[abc]', platform: 'ios' },
      });
      expect(res.statusCode).toBe(401);
    }

    await app.close();
    app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
      pushEnabled: true,
    });
    const withoutRegistry = await app.inject({
      method: 'POST',
      url: `/devices/${device.id}/push-token`,
      headers: { authorization: `Bearer ${device.token}` },
      payload: { expoToken: 'ExpoPushToken[abc]', platform: 'ios' },
    });
    expect(withoutRegistry.statusCode).toBe(401);
    expect(await ctx.store.listDevicePushTokens()).toEqual([]);
  });

  it('rejects malformed Expo tokens and unsupported platforms', async () => {
    const device = await pairedDevice();
    for (const payload of [
      { expoToken: 'not-an-expo-token', platform: 'ios' },
      { expoToken: 'ExpoPushToken[abc]', platform: 'android' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/devices/${device.id}/push-token`,
        headers: { authorization: `Bearer ${device.token}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('returns 503 without storing when push is disabled', async () => {
    await app.close();
    const device = await pairedDevice();
    app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
      authRegistry: registry,
      pushEnabled: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/devices/${device.id}/push-token`,
      headers: { authorization: `Bearer ${device.token}` },
      payload: { expoToken: 'ExpoPushToken[abc]', platform: 'ios' },
    });

    expect(res.statusCode).toBe(503);
    expect(await ctx.store.listDevicePushTokens()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().pushEnabled).toBe(false);
  });

  it('starts, wires fire points, and closes the configured sender with the server', async () => {
    await app.close();
    const start = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({
      targets: 1,
      ticketsAccepted: 1,
      ticketErrors: 0,
      receiptsQueued: 1,
      pruned: 0,
      transportErrors: 0,
    });
    const sender: PushSender = {
      send,
      processDueReceipts: vi.fn(),
      start,
      close,
    };
    const factory = vi.fn(() => sender);
    const bus = new InMemoryEventBus();
    // A session outside any project notifies its administrators.
    const device = await pairedDevice();
    await ctx.store.upsertDevicePushToken({
      authTokenId: device.id,
      expoToken: 'ExpoPushToken[phone]',
      platform: 'ios',
    });
    await ctx.store.createSession({ sessionId: 'session-1', worktree: '/wt/s1', model: 'm' });

    app = buildServer({
      eventStore: ctx.store,
      bus,
      conductor: {} as Conductor,
      authRegistry: registry,
      pushEnabled: true,
      pushSender: factory,
      pushFirePointDebounceMs: 0,
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    bus.publish('session-1', {
      seq: 1,
      ts: 1_000,
      event: { t: 'permission', id: 'tool-1', tool: 'Bash', input: {}, riskClass: 'ask' },
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await app.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('routes per user: silent while viewed, in-app on the foreground device, then escalated', async () => {
    await app.close();
    const phone = await pairedDevice();
    const tablet = await registry.mint('iPad');
    for (const [device, name] of [
      [phone, 'phone'],
      [tablet, 'tablet'],
    ] as const) {
      await ctx.store.upsertDevicePushToken({
        authTokenId: device.id,
        expoToken: `ExpoPushToken[${name}]`,
        platform: 'ios',
      });
    }
    await ctx.store.createSession({ sessionId: 'session-1', worktree: '/wt/s1', model: 'm' });
    const send = vi.fn<PushSender['send']>().mockResolvedValue({
      targets: 1,
      ticketsAccepted: 1,
      ticketErrors: 0,
      receiptsQueued: 1,
      pruned: 0,
      transportErrors: 0,
    });
    const sender: PushSender = {
      send,
      processDueReceipts: vi.fn(),
      start: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const bus = new InMemoryEventBus();
    app = buildServer({
      eventStore: ctx.store,
      bus,
      conductor: {} as Conductor,
      authRegistry: registry,
      pushEnabled: true,
      pushSender: sender,
      pushFirePointDebounceMs: 0,
      pushEscalationMs: 50,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const ticket = (
      await app.inject({
        method: 'POST',
        url: '/live/ticket',
        headers: { authorization: `Bearer ${phone.token}` },
      })
    ).json<{ ticket: string }>().ticket;
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(port)}/live`,
      `verity-live-ticket.${ticket}`,
    );
    const frames: { k: string; alert?: { toolUseId?: string } }[] = [];
    socket.addEventListener('message', (event) => {
      frames.push(JSON.parse(String(event.data)) as { k: string });
    });
    await vi.waitFor(() => expect(frames.some((frame) => frame.k === 'ready')).toBe(true));
    socket.send(JSON.stringify({ k: 'state', foreground: true }));
    socket.send(JSON.stringify({ k: 'sub', ch: 'session', id: 'session-1', view: true }));
    await vi.waitFor(() => expect(frames.some((frame) => frame.k === 'caught_up')).toBe(true));
    const permission = (id: string, seq: number): void => {
      bus.publish('session-1', {
        seq,
        ts: seq * 1_000,
        event: { t: 'permission', id, tool: 'Bash', input: {}, riskClass: 'ask' },
      });
    };
    const pushedTo = (call: number): string[] =>
      (send.mock.calls[call]?.[1] ?? []).map((token) => token.expoToken);

    // Looking at the session: no alert, no push.
    permission('p1', 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(send).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.k === 'alert')).toBe(false);

    // In the app but elsewhere: the phone shows it, the tablet hears after the escalation.
    socket.send(JSON.stringify({ k: 'view', id: 'session-1', view: false }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    permission('p2', 2);
    await vi.waitFor(() =>
      expect(frames.find((frame) => frame.k === 'alert')?.alert?.toolUseId).toBe('p2'),
    );
    expect(send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(pushedTo(0)).toEqual(['ExpoPushToken[tablet]']);

    // Nothing in the foreground: every device is pushed.
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener('close', () => resolve(), { once: true });
    });
    socket.close();
    await closed;
    let seq = 3;
    await vi.waitFor(() => {
      permission(`p${String(seq)}`, seq);
      seq += 1;
      expect(send.mock.calls.length).toBeGreaterThan(1);
    });
    expect(pushedTo(1).sort()).toEqual(['ExpoPushToken[phone]', 'ExpoPushToken[tablet]']);
  });
});
