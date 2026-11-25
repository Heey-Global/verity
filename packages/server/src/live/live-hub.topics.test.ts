import {
  LIVE_MAX_TOPIC_SUBSCRIPTIONS,
  type DomainEvent,
  type LiveServerFrame,
} from '@verity/events';
import type { SequencedEvent } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import { DomainEventBus } from './domain-events.js';
import { LiveHub, type LiveSessionRef, type LiveSocket } from './live-hub.js';

class FakeSocket implements LiveSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: LiveServerFrame[] = [];
  private readonly listeners = new Map<string, ((data?: unknown) => void)[]>();
  send(data: string): void {
    this.frames.push(JSON.parse(data) as LiveServerFrame);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  terminate(): void {
    this.readyState = 3;
  }
  ping(): void {}
  on(event: string, listener: (data?: unknown) => void): unknown {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }
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

const noBus = {
  subscribe: () => () => undefined,
  subscribeAll: () => () => undefined,
};

const lifecycle = (projectId: string, rev: number): DomainEvent => ({
  t: 'sandbox.lifecycle',
  projectId,
  rev,
  state: 'active',
});

function world({ topics = true }: { topics?: boolean } = {}) {
  const domainEvents = topics ? new DomainEventBus() : undefined;
  const sessions = new Map<string, LiveSessionRef>([
    ['s1', { sessionId: 's1', projectId: 'p1' }],
    ['s2', { sessionId: 's2', projectId: 'p2' }],
  ]);
  // alice may read p1; bob may read p1 and p2.
  const readable = new Map([
    ['alice', new Set(['p1'])],
    ['bob', new Set(['p1', 'p2'])],
  ]);
  let sessionReadsFail = false;
  const hub = new LiveHub({
    bus: noBus,
    store: {
      getSession: async (id) => {
        if (sessionReadsFail) throw new Error('store unavailable');
        return sessions.get(id);
      },
      getEventsAfter: async (): Promise<SequencedEvent[]> => [],
    },
    access: {
      canReadSession: async (userId, session) =>
        userId === undefined ||
        (session.projectId !== null && (readable.get(userId)?.has(session.projectId) ?? false)),
      overviewScope: async (userId) =>
        userId === undefined
          ? { all: true }
          : { all: false, projectIds: new Set(readable.get(userId) ?? []), unassigned: false },
    },
    domainEvents,
  });
  const connect = (userId?: string): FakeSocket => {
    const socket = new FakeSocket();
    hub.attach(socket, { userId, deviceId: `${userId ?? 'op'}-device` });
    return socket;
  };
  return {
    hub,
    bus: domainEvents,
    readable,
    connect,
    failSessionReads: () => {
      sessionReadsFail = true;
    },
  };
}

describe('LiveHub domain-event topics', () => {
  it('offers topics only when a bus is wired', () => {
    const withBus = world();
    expect(withBus.connect('alice').of('ready')[0]?.topics).toBe(true);
    const without = world({ topics: false });
    const socket = without.connect('alice');
    expect(socket.of('ready')[0]?.topics).toBeUndefined();
    withBus.hub.close();
    without.hub.close();
  });

  it('refuses topic frames when no bus is wired', async () => {
    const w = world({ topics: false });
    const socket = w.connect('alice');
    await socket.client({ k: 'topics.sub', topics: [{ topic: 'project:p1' }] });
    expect(socket.of('error')).toEqual([{ k: 'error', message: 'topics unavailable' }]);
    w.hub.close();
  });

  it('delivers the events of readable topics and refuses the others', async () => {
    const w = world();
    const socket = w.connect('alice');
    await socket.client({
      k: 'topics.sub',
      topics: [
        { topic: 'project:p1' },
        { topic: 'project:p2' },
        { topic: 'session:s1' },
        { topic: 'session:s2' },
        { topic: 'user:alice' },
        { topic: 'user:bob' },
      ],
    });
    expect(socket.of('topic_ended').map(({ topic, reason }) => [topic, reason])).toEqual(
      expect.arrayContaining([
        ['project:p2', 'forbidden'],
        ['session:s2', 'forbidden'],
        ['user:bob', 'forbidden'],
      ]),
    );
    expect(socket.of('topic_ended')).toHaveLength(3);
    w.bus!.publish('project:p1', lifecycle('p1', 1));
    w.bus!.publish('project:p2', lifecycle('p2', 1));
    expect(socket.of('domain').map(({ topic }) => topic)).toEqual(['project:p1']);
    w.hub.close();
  });

  it('replays missed events from the cursor and asks for a resync on a gap', async () => {
    const w = world();
    const first = w.bus!.publish('project:p1', lifecycle('p1', 1));
    w.bus!.publish('project:p1', lifecycle('p1', 2));
    const socket = w.connect('bob');
    await socket.client({
      k: 'topics.sub',
      topics: [
        { topic: 'project:p1', cursor: first.cursor },
        { topic: 'project:p2', cursor: 1 },
      ],
    });
    expect(socket.of('domain').map(({ event }) => event)).toEqual([lifecycle('p1', 2)]);
    expect(socket.of('resync')).toEqual([
      { k: 'resync', topic: 'project:p2', cursor: w.bus!.head },
    ]);
    w.hub.close();
  });

  it('answers a subscription without a cursor with a resync once it is live', async () => {
    // The client reads its snapshot on this resync. Were it to read before the
    // subscription is live (authorization is async), a change published in
    // between would be in neither the snapshot nor the stream.
    const w = world();
    const socket = w.connect('alice');
    await socket.client({ k: 'topics.sub', topics: [{ topic: 'project:p1' }] });
    expect(socket.of('resync')).toEqual([
      { k: 'resync', topic: 'project:p1', cursor: w.bus!.head },
    ]);
    const record = w.bus!.publish('project:p1', lifecycle('p1', 1));
    expect(socket.of('domain').map(({ cursor }) => cursor)).toEqual([record.cursor]);
    w.hub.close();
  });

  it('rechecks topics even when rechecking session streams fails', async () => {
    const w = world();
    const socket = w.connect('bob');
    await socket.client({ k: 'sub', ch: 'session', id: 's2' });
    await socket.client({ k: 'topics.sub', topics: [{ topic: 'project:p2' }] });
    w.failSessionReads();
    w.readable.set('bob', new Set(['p1']));
    w.hub.authorizationChanged({ userId: 'bob' });
    await vi.waitFor(() =>
      expect(socket.of('topic_ended')).toEqual([
        { k: 'topic_ended', topic: 'project:p2', reason: 'forbidden' },
      ]),
    );
    w.hub.close();
  });

  it('fails closed when a recheck cannot decide', async () => {
    const w = world();
    const socket = w.connect('bob');
    await socket.client({ k: 'topics.sub', topics: [{ topic: 'project:p2' }] });
    w.readable.delete('bob');
    w.readable.set('bob', {
      has: () => {
        throw new Error('membership store unavailable');
      },
    } as unknown as Set<string>);
    w.hub.authorizationChanged({ userId: 'bob' });
    await vi.waitFor(() => expect(socket.of('topic_ended')).toHaveLength(1));
    expect(socket.of('topic_ended')[0]).toMatchObject({ topic: 'project:p2', reason: 'error' });
    w.hub.close();
  });

  it('ends a topic whose access was revoked while the socket stayed open', async () => {
    const w = world();
    const socket = w.connect('bob');
    await socket.client({ k: 'topics.sub', topics: [{ topic: 'project:p2' }] });
    w.readable.set('bob', new Set(['p1']));
    w.hub.authorizationChanged({ userId: 'bob' });
    await vi.waitFor(() => expect(socket.of('topic_ended')).toHaveLength(1));
    expect(socket.of('topic_ended')[0]).toMatchObject({ topic: 'project:p2', reason: 'forbidden' });
    w.bus!.publish('project:p2', lifecycle('p2', 1));
    expect(socket.of('domain')).toEqual([]);
    w.hub.close();
  });

  it('stops delivery after unsubscribe and when the socket closes', async () => {
    const w = world();
    const socket = w.connect('alice');
    await socket.client({ k: 'topics.sub', topics: [{ topic: 'project:p1' }] });
    await socket.client({ k: 'topics.unsub', topics: ['project:p1'] });
    w.bus!.publish('project:p1', lifecycle('p1', 1));
    expect(socket.of('domain')).toEqual([]);

    const other = w.connect('alice');
    await other.client({ k: 'topics.sub', topics: [{ topic: 'project:p1' }] });
    other.close();
    w.bus!.publish('project:p1', lifecycle('p1', 2));
    expect(other.of('domain')).toEqual([]);
    w.hub.close();
  });

  it('bounds the topics one connection may hold', async () => {
    const w = world();
    const socket = w.connect();
    const topics = Array.from({ length: LIVE_MAX_TOPIC_SUBSCRIPTIONS }, (_, i) => ({
      topic: `user:u${String(i)}`,
    }));
    await socket.client({ k: 'topics.sub', topics });
    await socket.client({ k: 'topics.sub', topics: [{ topic: 'user:one-too-many' }] });
    expect(socket.of('topic_ended')).toEqual([
      { k: 'topic_ended', topic: 'user:one-too-many', reason: 'limit' },
    ]);
    w.hub.close();
  });

  it('asks again once a socket drains, even when the topic stays quiet', async () => {
    // A one-shot event (a new permission request) dropped after the first
    // resync must not wait for some later event on the topic.
    const w = world();
    const socket = w.connect('alice');
    await socket.client({ k: 'topics.sub', topics: [{ topic: 'project:p1' }] });
    socket.frames.length = 0;
    socket.bufferedAmount = Number.MAX_SAFE_INTEGER;
    w.bus!.publish('project:p1', lifecycle('p1', 1));
    w.bus!.publish('project:p1', lifecycle('p1', 2));
    expect(socket.of('resync')).toHaveLength(1);
    socket.bufferedAmount = 0;
    await vi.waitFor(() => expect(socket.of('resync')).toHaveLength(2));
    expect(socket.of('resync')[1]).toEqual({
      k: 'resync',
      topic: 'project:p1',
      cursor: w.bus!.head,
    });
    w.hub.close();
  });

  it('asks a socket that fell behind to resync instead of queueing frames', async () => {
    const w = world();
    const socket = w.connect('alice');
    await socket.client({ k: 'topics.sub', topics: [{ topic: 'project:p1' }] });
    socket.frames.length = 0;
    socket.bufferedAmount = Number.MAX_SAFE_INTEGER;
    const dropped = w.bus!.publish('project:p1', lifecycle('p1', 1));
    w.bus!.publish('project:p1', lifecycle('p1', 2));
    expect(socket.of('domain')).toEqual([]);
    expect(socket.of('resync')).toEqual([
      { k: 'resync', topic: 'project:p1', cursor: dropped.cursor },
    ]);
    // Caught up again: one more resync covers what was dropped after the first.
    socket.bufferedAmount = 0;
    const next = w.bus!.publish('project:p1', lifecycle('p1', 3));
    expect(socket.of('resync')).toHaveLength(2);
    expect(socket.of('domain').map(({ cursor }) => cursor)).toEqual([next.cursor]);
    w.hub.close();
  });
});
