import type { LiveClientFrame, LiveServerFrame } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';
import { VerityApiError } from '../api.js';
import {
  LiveConnection,
  liveConnectionFailure,
  type LiveConnectionOptions,
  type LiveSessionSink,
  type LiveSocket,
} from './connection.js';

type Listener = (event: { data?: unknown; code?: number }) => void;

class FakeSocket implements LiveSocket {
  readonly sent: LiveClientFrame[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(
    readonly url: string,
    readonly protocols: string | string[] | undefined,
  ) {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as LiveClientFrame);
  }
  close(): void {
    this.closed = true;
  }
  serve(frame: LiveServerFrame): void {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data: JSON.stringify(frame) });
  }
  ready(): void {
    this.serve({ k: 'ready', v: 1, maxSessions: 8 });
  }
  drop(code = 1006): void {
    for (const listener of this.listeners.get('close') ?? []) listener({ code });
  }
}

interface Harness {
  connection: LiveConnection;
  sockets: FakeSocket[];
  retries: { run: () => void; delayMs: number }[];
  runRetry(): void;
  tick(): void;
  now: { value: number };
}

async function harness(overrides: Partial<LiveConnectionOptions> = {}): Promise<Harness> {
  const sockets: FakeSocket[] = [];
  const retries: { run: () => void; delayMs: number }[] = [];
  const now = { value: 0 };
  let keepalive: (() => void) | undefined;
  const connection = new LiveConnection({
    baseUrl: 'https://core.example/',
    connect: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    getTicket: async () => `ticket-${String(sockets.length + 1)}`,
    scheduleReconnect: (run, delayMs) => retries.push({ run, delayMs }),
    setInterval: (callback) => {
      keepalive = callback;
      return 1;
    },
    clearInterval: () => {
      keepalive = undefined;
    },
    now: () => now.value,
    ...overrides,
  });
  connection.start();
  await flush();
  return {
    connection,
    sockets,
    retries,
    runRetry: () => retries.shift()?.run(),
    tick: () => keepalive?.(),
    now,
  };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function sink(cursor = 0): Omit<LiveSessionSink, 'caughtUp' | 'ended' | 'disconnected'> & {
  events: number[];
  caughtUp: ReturnType<typeof vi.fn<LiveSessionSink['caughtUp']>>;
  ended: ReturnType<typeof vi.fn<LiveSessionSink['ended']>>;
  disconnected: ReturnType<typeof vi.fn<LiveSessionSink['disconnected']>>;
} {
  const events: number[] = [];
  let position = cursor;
  return {
    events,
    cursor: () => position,
    event: (frame) => {
      events.push(frame.seq);
      position = frame.seq;
    },
    caughtUp: vi.fn<LiveSessionSink['caughtUp']>(),
    ended: vi.fn<LiveSessionSink['ended']>(),
    disconnected: vi.fn<LiveSessionSink['disconnected']>(),
  };
}

describe('LiveConnection', () => {
  it('connects to /live with the ticket as a subprotocol, never in the URL', async () => {
    const h = await harness();
    expect(h.sockets[0]?.url).toBe('wss://core.example/live');
    expect(h.sockets[0]?.protocols).toBe('verity-live-ticket.ticket-1');
    expect(h.sockets[0]?.url).not.toContain('ticket');
  });

  it('declares foreground state and subscriptions once the server is ready', async () => {
    const h = await harness();
    h.connection.setForeground(true);
    h.connection.onHints(() => undefined);
    h.connection.subscribeSession('s1', sink(41), true);
    // Nothing goes out before `ready`.
    expect(h.sockets[0]?.sent).toEqual([]);
    h.sockets[0]?.ready();
    expect(h.sockets[0]?.sent).toEqual([
      { k: 'state', foreground: true },
      { k: 'sub', ch: 'overview' },
      { k: 'sub', ch: 'session', id: 's1', sinceSeq: 41, view: true },
    ]);
    expect(h.connection.connectionState).toBe('connected');
  });

  it('routes session frames to their sink, hints and alerts to their listeners', async () => {
    const h = await harness();
    const s1 = sink();
    const hints = vi.fn();
    const alerts = vi.fn();
    h.connection.subscribeSession('s1', s1, false);
    h.connection.onHints(hints);
    h.connection.onAlert(alerts);
    h.sockets[0]?.ready();
    h.sockets[0]?.serve({ k: 'event', id: 's1', seq: 5, event: { t: 'text', delta: 'x' } });
    h.sockets[0]?.serve({ k: 'event', id: 'other', seq: 6, event: { t: 'text', delta: 'y' } });
    h.sockets[0]?.serve({ k: 'caught_up', id: 's1', seq: 5 });
    h.sockets[0]?.serve({ k: 'hint', hints: [{ sessionId: 's1', topics: ['status'] }] });
    const alert = {
      sessionId: 's1',
      kind: 'permission' as const,
      categoryId: 'PERMISSION_PROMPT',
      toolUseId: 't1',
      title: 'Permission needed',
      body: 'A session requests permission to continue.',
    };
    h.sockets[0]?.serve({ k: 'alert', alert });

    expect(s1.events).toEqual([5]);
    expect(s1.caughtUp).toHaveBeenCalledWith(5);
    expect(hints).toHaveBeenCalledWith([{ sessionId: 's1', topics: ['status'] }]);
    expect(alerts).toHaveBeenCalledWith(alert);
  });

  it('reconnects with backoff after a drop and resubscribes from each cursor', async () => {
    const h = await harness();
    const s1 = sink();
    h.connection.subscribeSession('s1', s1, false);
    h.sockets[0]?.ready();
    h.sockets[0]?.serve({ k: 'event', id: 's1', seq: 9, event: { t: 'text', delta: 'x' } });
    h.sockets[0]?.drop();
    expect(s1.disconnected).toHaveBeenCalled();
    expect(h.connection.connectionState).toBe('connecting');
    expect(h.retries.map((retry) => retry.delayMs)).toEqual([1_000]);

    h.runRetry();
    await flush();
    h.sockets[1]?.drop();
    expect(h.retries.map((retry) => retry.delayMs)).toEqual([2_000]);
    h.runRetry();
    await flush();
    h.sockets[2]?.ready();
    expect(h.sockets[2]?.sent).toContainEqual({
      k: 'sub',
      ch: 'session',
      id: 's1',
      sinceSeq: 9,
      view: false,
    });
    // `ready` resets the backoff.
    h.sockets[2]?.drop();
    expect(h.retries.map((retry) => retry.delayMs)).toEqual([1_000]);
  });

  it('caps the reconnect delay', async () => {
    const h = await harness();
    for (let i = 0; i < 8; i += 1) {
      h.sockets.at(-1)?.drop();
      h.runRetry();
      await flush();
    }
    h.sockets.at(-1)?.drop();
    expect(h.retries.at(-1)?.delayMs).toBe(30_000);
  });

  it('retries a policy close once with a fresh ticket, then reports the device unauthorized', async () => {
    const h = await harness();
    h.sockets[0]?.drop(1008);
    expect(h.connection.connectionState).toBe('connecting');
    h.runRetry();
    await flush();
    expect(h.sockets[1]?.protocols).toBe('verity-live-ticket.ticket-2');
    h.sockets[1]?.drop(1008);
    expect(h.connection.connectionState).toBe('unauthorized');
    expect(h.retries).toEqual([]);
  });

  it('resubscribes at once after an overflow and retries a failed replay later', async () => {
    const h = await harness();
    const s1 = sink(3);
    h.connection.subscribeSession('s1', s1, false);
    h.sockets[0]?.ready();
    const subs = (): LiveClientFrame[] =>
      h.sockets[0]?.sent.filter((frame) => frame.k === 'sub') ?? [];
    expect(subs()).toHaveLength(1);
    h.sockets[0]?.serve({ k: 'ended', id: 's1', reason: 'overflow' });
    expect(subs()).toHaveLength(2);
    h.sockets[0]?.serve({ k: 'ended', id: 's1', reason: 'error' });
    expect(s1.disconnected).toHaveBeenCalled();
    expect(h.retries.map((retry) => retry.delayMs)).toEqual([5_000]);
    h.runRetry();
    expect(subs()).toHaveLength(3);
    expect(s1.ended).not.toHaveBeenCalled();
  });

  it('gives up a subscription the server refuses', async () => {
    const h = await harness();
    const s1 = sink();
    h.connection.subscribeSession('s1', s1, false);
    h.sockets[0]?.ready();
    h.sockets[0]?.serve({ k: 'ended', id: 's1', reason: 'forbidden' });
    expect(s1.ended).toHaveBeenCalledWith('forbidden');
    // Not resubscribed after a reconnect.
    h.sockets[0]?.drop();
    h.runRetry();
    await flush();
    h.sockets[1]?.ready();
    expect(h.sockets[1]?.sent.filter((frame) => frame.k === 'sub')).toEqual([]);
  });

  it('resumes shared subscriptions from the lowest required cursor', async () => {
    const h = await harness();
    const first = sink(10);
    h.connection.subscribeSession('s1', first, false);
    h.sockets[0]!.ready();
    h.sockets[0]!.drop();
    h.connection.subscribeSession('s1', sink(20), true);
    h.runRetry();
    await flush();
    h.sockets[1]!.ready();
    expect(h.sockets[1]!.sent).toContainEqual({
      k: 'sub',
      ch: 'session',
      id: 's1',
      sinceSeq: 10,
      view: true,
    });
    h.sockets[1]!.serve({
      k: 'event',
      id: 's1',
      seq: 11,
      ts: 0,
      event: { t: 'text', delta: 'missing' },
    });
    expect(first.events).toContain(11);
    h.connection.stop();
  });

  it('shares one server subscription between two screens of a session', async () => {
    const h = await harness();
    h.sockets[0]?.ready();
    const list = h.connection.subscribeSession('s1', sink(), false);
    const screen = h.connection.subscribeSession('s1', sink(), true);
    screen.close();
    expect(h.sockets[0]?.sent.at(-1)).toEqual({ k: 'view', id: 's1', view: false });
    list.close();
    expect(h.sockets[0]?.sent.at(-1)).toEqual({ k: 'unsub', ch: 'session', id: 's1' });
  });

  it('closes in the background and reconnects on resume', async () => {
    const h = await harness();
    const s1 = sink();
    h.connection.subscribeSession('s1', s1, true);
    h.sockets[0]?.ready();
    h.connection.pause();
    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.connection.connectionState).toBe('paused');
    // A late close from the paused socket schedules nothing.
    h.sockets[0]?.drop();
    expect(h.retries).toEqual([]);
    h.connection.resume();
    await flush();
    expect(h.sockets).toHaveLength(2);
  });

  it('treats a silent socket as dead', async () => {
    const h = await harness({ silenceTimeoutMs: 60_000 });
    h.sockets[0]?.ready();
    h.now.value = 30_000;
    h.tick();
    expect(h.sockets[0]?.sent.at(-1)).toEqual({ k: 'ping', n: 1 });
    expect(h.sockets[0]?.closed).toBe(false);
    h.now.value = 61_000;
    h.tick();
    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.retries).toHaveLength(1);
  });

  it('tells subscribers why it could not connect, without server detail', async () => {
    const h = await harness({
      getTicket: async () => {
        throw new VerityApiError(503, 'secret server body');
      },
    });
    const s1 = sink();
    h.connection.subscribeSession('s1', s1, false);
    h.connection.reconnect();
    await flush();
    expect(s1.disconnected).toHaveBeenCalledWith(
      'Could not open the session: Core could not issue a connection ticket (HTTP 503). Retry in a moment.',
    );
    expect(JSON.stringify(s1.disconnected.mock.calls)).not.toContain('secret');
  });

  it.each([
    [
      new VerityApiError(401, 'secret server body'),
      "Could not open the session: Core rejected this device's authorization (HTTP 401). Sign in again and retry.",
    ],
    [
      Object.assign(new Error('Uplink attachment and direct Core request failed: secret'), {
        name: 'VerityConnectionError',
      }),
      'Could not open the session: Uplink attachment failed, and Core was unreachable directly. Check your connection and retry.',
    ],
    [
      Object.assign(new Error('Direct Core request failed: secret'), {
        name: 'VerityConnectionError',
      }),
      'Could not open the session: Core is unreachable at the paired address. Connect through VPN or enable Remote Control, then retry. (Direct Core)',
    ],
    [
      Object.assign(
        new Error(
          'Uplink admission (Remote admission failed: unavailable.) and direct Core request failed: secret',
        ),
        { name: 'VerityConnectionError' },
      ),
      'Could not open the session: Uplink admission failed (unavailable), and Core was unreachable directly. Check your connection and retry.',
    ],
    [
      Object.assign(
        new Error(
          'Uplink routing (no remote descriptor saved) and direct Core request failed: secret',
        ),
        { name: 'VerityConnectionError' },
      ),
      'Could not open the session: Remote Control is not configured on this device and the direct Core connection failed. Connect to Core through VPN once, then retry without VPN. (Uplink routing)',
    ],
    [
      new Error('secret'),
      'Could not open the session: the connection failed before Core could authorize the connection. Retry in a moment.',
    ],
  ])('classifies a ticket failure safely: %s', (error, expected) => {
    expect(liveConnectionFailure(error)).toBe(expected);
    expect(liveConnectionFailure(error)).not.toContain('secret');
  });
});
