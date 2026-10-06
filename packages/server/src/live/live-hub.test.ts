import type { AgentEvent, LiveServerFrame } from '@verity/events';
import type { SequencedEvent } from '@verity/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveHub, type LiveHubDeps, type LiveSessionRef, type LiveSocket } from './live-hub.js';

class FakeSocket implements LiveSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: LiveServerFrame[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | undefined;
  terminated = false;
  pings = 0;
  private readonly listeners = new Map<string, ((data?: unknown) => void)[]>();

  send(data: string): void {
    this.frames.push(JSON.parse(data) as LiveServerFrame);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  ping(): void {
    this.pings += 1;
  }
  on(event: string, listener: (data?: unknown) => void): unknown {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }
  /** Send a client frame and let the hub's async handling settle. */
  async client(frame: object): Promise<void> {
    this.emit('message', JSON.stringify(frame));
    await vi.waitFor(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  of<K extends LiveServerFrame['k']>(k: K): Extract<LiveServerFrame, { k: K }>[] {
    return this.frames.filter(
      (frame): frame is Extract<LiveServerFrame, { k: K }> => frame.k === k,
    );
  }
}

class FakeBus {
  private readonly listeners = new Map<string, Set<(event: SequencedEvent) => void>>();
  private readonly observers = new Set<(sessionId: string, event: SequencedEvent) => void>();
  publish(sessionId: string, event: SequencedEvent): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
    for (const observer of this.observers) observer(sessionId, event);
  }
  subscribe(sessionId: string, listener: (event: SequencedEvent) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => set.delete(listener);
  }
  subscribeAll(observer: (sessionId: string, event: SequencedEvent) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }
}

const text = (delta: string): AgentEvent => ({ t: 'text', delta });
const seqd = (seq: number, event: AgentEvent = text(`e${String(seq)}`)): SequencedEvent => ({
  seq,
  ts: seq * 1000,
  event,
});

interface World {
  hub: LiveHub;
  bus: FakeBus;
  log: Map<string, SequencedEvent[]>;
  sessions: Map<string, LiveSessionRef>;
  readable: Map<string, Set<string>>;
  administrators: Set<string>;
  pageReads: number[];
}

function world(overrides: Partial<LiveHubDeps> = {}): World {
  const bus = new FakeBus();
  const log = new Map<string, SequencedEvent[]>();
  const sessions = new Map<string, LiveSessionRef>([
    ['s1', { sessionId: 's1', projectId: 'p1' }],
    ['s2', { sessionId: 's2', projectId: 'p2' }],
  ]);
  // alice may read p1; bob may read p1 and p2.
  const readable = new Map([
    ['alice', new Set(['p1'])],
    ['bob', new Set(['p1', 'p2'])],
  ]);
  const administrators = new Set<string>();
  const pageReads: number[] = [];
  const hub = new LiveHub({
    bus,
    store: {
      getSession: async (id) => sessions.get(id),
      getEventsAfter: async (id, after, limit) => {
        pageReads.push(after);
        return (log.get(id) ?? []).filter((event) => event.seq > after).slice(0, limit);
      },
    },
    access: {
      canReadSession: async (userId, session) =>
        userId === undefined ||
        (session.projectId === null
          ? administrators.has(userId)
          : (readable.get(userId)?.has(session.projectId) ?? false)),
      overviewScope: async (userId) =>
        userId === undefined
          ? { all: true }
          : {
              all: false,
              projectIds: new Set(readable.get(userId) ?? []),
              unassigned: administrators.has(userId),
            },
      isActiveUser: async () => true,
    },
    hintDelayMs: 5,
    ...overrides,
  });
  return { hub, bus, log, sessions, readable, administrators, pageReads };
}

function connect(w: World, userId?: string, deviceId?: string): FakeSocket {
  const socket = new FakeSocket();
  w.hub.attach(socket, { userId, deviceId });
  return socket;
}

describe('LiveHub', () => {
  afterEach(() => vi.useRealTimers());

  it('greets every connection with the protocol version and its limits', () => {
    const w = world();
    const socket = connect(w, 'alice', 'd1');
    expect(socket.frames[0]).toEqual({ k: 'ready', v: 1, maxSessions: 8 });
    w.hub.close();
  });

  describe('session subscriptions', () => {
    it('replays from the cursor, marks caught_up, then streams live without duplicates', async () => {
      const w = world();
      w.log.set('s1', [seqd(1), seqd(2), seqd(3)]);
      const socket = connect(w, 'alice', 'd1');
      await socket.client({ k: 'sub', ch: 'session', id: 's1', sinceSeq: 1 });
      // An event persisted during the replay is published too; it is sent once.
      w.bus.publish('s1', seqd(3));
      w.bus.publish('s1', seqd(4));

      expect(socket.of('event').map((frame) => frame.seq)).toEqual([2, 3, 4]);
      expect(socket.of('caught_up')).toEqual([{ k: 'caught_up', id: 's1', seq: 3 }]);
      w.hub.close();
    });

    it('holds live events published while the backlog is still being read', async () => {
      const w = world();
      w.log.set('s1', [seqd(1)]);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = w.hub.deps.store.getEventsAfter.bind(w.hub.deps.store);
      w.hub.deps.store.getEventsAfter = async (...args) => {
        await gate;
        return original(...args);
      };
      const socket = connect(w, 'alice', 'd1');
      socket.emit('message', JSON.stringify({ k: 'sub', ch: 'session', id: 's1' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      w.bus.publish('s1', seqd(2));
      expect(socket.of('event')).toEqual([]);
      release();
      await vi.waitFor(() => expect(socket.of('event').map((frame) => frame.seq)).toEqual([1, 2]));
      w.hub.close();
    });

    it('reads a long backlog in pages instead of one unbounded query', async () => {
      const w = world({ replayPageSize: 2 });
      w.log.set(
        's1',
        [1, 2, 3, 4, 5].map((seq) => seqd(seq)),
      );
      const socket = connect(w, 'alice', 'd1');
      await socket.client({ k: 'sub', ch: 'session', id: 's1' });
      await vi.waitFor(() => expect(socket.of('caught_up')).toHaveLength(1));

      expect(w.pageReads).toEqual([0, 2, 4]);
      expect(socket.of('event').map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5]);
      w.hub.close();
    });

    it('refuses a session of a project the user may not read', async () => {
      const w = world();
      w.log.set('s2', [seqd(1)]);
      const socket = connect(w, 'alice', 'd1');
      await socket.client({ k: 'sub', ch: 'session', id: 's2' });

      expect(socket.of('ended')).toEqual([{ k: 'ended', id: 's2', reason: 'forbidden' }]);
      expect(socket.of('event')).toEqual([]);
      expect(w.bus.listenerCount('s2')).toBe(0);
      w.hub.close();
    });

    it('reports a session that does not exist', async () => {
      const w = world();
      const socket = connect(w, 'alice', 'd1');
      await socket.client({ k: 'sub', ch: 'session', id: 'missing' });
      expect(socket.of('ended')).toEqual([{ k: 'ended', id: 'missing', reason: 'not_found' }]);
      w.hub.close();
    });

    it('reauthorizes moved sessions before destination events reach old project members', async () => {
      const w = world();
      const alice = connect(w, 'alice', 'd1');
      const bob = connect(w, 'bob', 'd2');
      await alice.client({ k: 'sub', ch: 'session', id: 's1' });
      await bob.client({ k: 'sub', ch: 'session', id: 's1' });
      w.sessions.set('s1', { sessionId: 's1', projectId: 'p2' });
      await w.hub.recheckSession('s1');
      w.bus.publish('s1', seqd(9));
      expect(alice.of('ended')).toEqual([{ k: 'ended', id: 's1', reason: 'forbidden' }]);
      expect(alice.of('event')).toEqual([]);
      expect(bob.of('event')).toHaveLength(1);
      w.hub.close();
    });

    it('ends a subscription whose access was withdrawn while the socket stayed open', async () => {
      const w = world();
      const socket = connect(w, 'alice', 'd1');
      await socket.client({ k: 'sub', ch: 'session', id: 's1' });
      w.readable.set('alice', new Set());
      w.hub.authorizationChanged({ userId: 'alice' });
      await vi.waitFor(() =>
        expect(socket.of('ended')).toEqual([{ k: 'ended', id: 's1', reason: 'forbidden' }]),
      );
      w.bus.publish('s1', seqd(9));
      expect(socket.of('event')).toEqual([]);
      w.hub.close();
    });

    it('ends a subscription the socket cannot keep up with, so the client resumes from its cursor', async () => {
      const w = world({ maxBufferedBytes: 100 });
      const socket = connect(w, 'alice', 'd1');
      await socket.client({ k: 'sub', ch: 'session', id: 's1' });
      w.bus.publish('s1', seqd(1));
      socket.bufferedAmount = 1_000;
      w.bus.publish('s1', seqd(2));

      expect(socket.of('event').map((frame) => frame.seq)).toEqual([1]);
      expect(socket.of('ended')).toEqual([{ k: 'ended', id: 's1', reason: 'overflow' }]);
      w.hub.close();
    });

    it('caps concurrent subscriptions per connection', async () => {
      const w = world();
      for (let i = 0; i < 9; i += 1)
        w.sessions.set(`x${String(i)}`, { sessionId: `x${String(i)}`, projectId: 'p1' });
      const socket = connect(w, 'alice', 'd1');
      for (let i = 0; i < 9; i += 1)
        await socket.client({ k: 'sub', ch: 'session', id: `x${String(i)}` });
      expect(socket.of('ended')).toEqual([{ k: 'ended', id: 'x8', reason: 'limit' }]);
      w.hub.close();
    });

    it('stops streaming after unsub', async () => {
      const w = world();
      const socket = connect(w, 'alice', 'd1');
      await socket.client({ k: 'sub', ch: 'session', id: 's1' });
      await socket.client({ k: 'unsub', ch: 'session', id: 's1' });
      w.bus.publish('s1', seqd(1));
      expect(socket.of('event')).toEqual([]);
      expect(w.bus.listenerCount('s1')).toBe(0);
      w.hub.close();
    });
  });

  describe('overview hints', () => {
    it('hints only sessions of projects the user may read, and without content', async () => {
      const w = world();
      const alice = connect(w, 'alice', 'd1');
      const bob = connect(w, 'bob', 'd2');
      await alice.client({ k: 'sub', ch: 'overview' });
      await bob.client({ k: 'sub', ch: 'overview' });
      w.bus.publish('s1', seqd(1, text('secret prose')));
      w.bus.publish(
        's2',
        seqd(2, {
          t: 'permission',
          id: 't',
          tool: 'Bash',
          input: { command: 'wipe-the-disk' },
          riskClass: 'ask',
        }),
      );

      await vi.waitFor(() => expect(bob.of('hint')).toHaveLength(1));
      await vi.waitFor(() => expect(alice.of('hint')).toHaveLength(1));
      expect(alice.of('hint')[0]?.hints.map((hint) => hint.sessionId)).toEqual(['s1']);
      expect(bob.of('hint')[0]?.hints).toEqual([
        { sessionId: 's1', projectId: 'p1', topics: ['events'] },
        { sessionId: 's2', projectId: 'p2', topics: ['events', 'status', 'permission'] },
      ]);
      expect(JSON.stringify(bob.frames)).not.toContain('secret prose');
      expect(JSON.stringify(bob.frames)).not.toContain('wipe-the-disk');
      w.hub.close();
    });

    it('coalesces a burst into one hint per session', async () => {
      const w = world();
      const socket = connect(w, 'alice', 'd1');
      await socket.client({ k: 'sub', ch: 'overview' });
      for (let seq = 1; seq <= 20; seq += 1) w.bus.publish('s1', seqd(seq));
      await vi.waitFor(() => expect(socket.of('hint')).toHaveLength(1));
      expect(socket.of('hint')[0]?.hints).toHaveLength(1);
      w.hub.close();
    });

    it('sends no hints to a connection that did not subscribe to the overview', async () => {
      const w = world();
      const watcher = connect(w, 'bob', 'd2');
      await watcher.client({ k: 'sub', ch: 'overview' });
      const socket = connect(w, 'alice', 'd1');
      w.bus.publish('s1', seqd(1));
      await vi.waitFor(() => expect(watcher.of('hint')).toHaveLength(1));
      expect(socket.of('hint')).toEqual([]);
      w.hub.close();
    });

    it('lets an administrator hear about sessions outside any project, and nobody else', async () => {
      const w = world();
      w.sessions.set('loose', { sessionId: 'loose', projectId: null });
      w.administrators.add('bob');
      const alice = connect(w, 'alice', 'd1');
      const bob = connect(w, 'bob', 'd2');
      await alice.client({ k: 'sub', ch: 'overview' });
      await bob.client({ k: 'sub', ch: 'overview' });
      w.bus.publish('loose', seqd(1));
      await vi.waitFor(() => expect(bob.of('hint')).toHaveLength(1));
      expect(alice.of('hint')).toEqual([]);
      w.hub.close();
    });
  });

  describe('presence', () => {
    it('counts a session as viewed only while its viewer is in the foreground', async () => {
      const w = world();
      const socket = connect(w, 'alice', 'phone');
      await socket.client({ k: 'sub', ch: 'session', id: 's1', view: true });
      expect(w.hub.isViewing('alice', 's1')).toBe(false);
      await socket.client({ k: 'state', foreground: true });
      expect(w.hub.isViewing('alice', 's1')).toBe(true);
      expect(w.hub.isViewing('bob', 's1')).toBe(false);
      await socket.client({ k: 'view', id: 's1', view: false });
      expect(w.hub.isViewing('alice', 's1')).toBe(false);
      w.hub.close();
    });

    it("lists a user's foreground devices and delivers alerts only there", async () => {
      const w = world();
      const phone = connect(w, 'alice', 'phone');
      const tablet = connect(w, 'alice', 'tablet');
      const bob = connect(w, 'bob', 'bob-phone');
      await phone.client({ k: 'state', foreground: true });
      await bob.client({ k: 'state', foreground: true });
      expect([...w.hub.foregroundDevices('alice')]).toEqual(['phone']);

      const alert = {
        sessionId: 's1',
        kind: 'permission' as const,
        categoryId: 'PERMISSION_PROMPT',
        toolUseId: 't1',
        title: 'Permission needed',
        body: 'A session requests permission to continue.',
      };
      expect([...w.hub.deliverAlert('alice', alert)]).toEqual(['phone']);
      expect(phone.of('alert')).toEqual([{ k: 'alert', alert }]);
      expect(tablet.of('alert')).toEqual([]);
      expect(bob.of('alert')).toEqual([]);
      w.hub.close();
    });

    it('forgets a device the moment its socket closes', async () => {
      const w = world();
      const phone = connect(w, 'alice', 'phone');
      await phone.client({ k: 'state', foreground: true });
      phone.close(1000);
      expect(w.hub.foregroundDevices('alice').size).toBe(0);
      w.hub.close();
    });
  });

  describe('lifecycle', () => {
    it('closes the sockets of a revoked device and only those', async () => {
      const w = world();
      const revoked = connect(w, 'alice', 'phone');
      const other = connect(w, 'alice', 'tablet');
      w.hub.revokeDevice('phone');
      expect(revoked.closedWith).toEqual({ code: 1008, reason: 'unauthorized' });
      expect(other.closedWith).toBeUndefined();
      w.hub.close();
    });

    it('drops a connection that stopped answering pings, so it no longer counts as foreground', async () => {
      vi.useFakeTimers();
      let now = 0;
      const w = world({ now: () => now, pingIntervalMs: 20_000, pongTimeoutMs: 45_000 });
      const phone = connect(w, 'alice', 'phone');
      await vi.advanceTimersByTimeAsync(0);
      phone.emit('message', JSON.stringify({ k: 'state', foreground: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(w.hub.foregroundDevices('alice').size).toBe(1);

      now = 40_000;
      await vi.advanceTimersByTimeAsync(40_000);
      expect(phone.pings).toBe(2);
      expect(phone.terminated).toBe(false);
      now = 60_000;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(phone.terminated).toBe(true);
      expect(w.hub.foregroundDevices('alice').size).toBe(0);
      w.hub.close();
    });

    it('keeps a connection that answers pings', async () => {
      vi.useFakeTimers();
      let now = 0;
      const w = world({ now: () => now, pingIntervalMs: 20_000, pongTimeoutMs: 45_000 });
      const phone = connect(w, 'alice', 'phone');
      for (let i = 1; i <= 5; i += 1) {
        now = i * 20_000;
        phone.emit('pong');
        await vi.advanceTimersByTimeAsync(20_000);
      }
      expect(phone.terminated).toBe(false);
      w.hub.close();
    });

    it('answers a client ping and rejects a malformed frame without closing', async () => {
      const w = world();
      const socket = connect(w, 'alice', 'd1');
      await socket.client({ k: 'ping', n: 7 });
      socket.emit('message', 'not json');
      expect(socket.of('pong')).toEqual([{ k: 'pong', n: 7 }]);
      expect(socket.of('error')).toEqual([{ k: 'error', message: 'invalid frame' }]);
      expect(socket.closedWith).toBeUndefined();
      w.hub.close();
    });
  });
});
