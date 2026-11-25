import type { DomainEvent, LiveClientFrame, LiveServerFrame } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';
import { LiveConnection, type LiveSocket } from './connection.js';
import type { LiveTopicSink } from './topics.js';

type Listener = (event: { data?: unknown; code?: number }) => void;

class FakeSocket implements LiveSocket {
  readonly sent: LiveClientFrame[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as LiveClientFrame);
  }
  close(): void {}
  serve(frame: LiveServerFrame): void {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data: JSON.stringify(frame) });
  }
  ready(topics: boolean): void {
    this.serve({ k: 'ready', v: 2, maxSessions: 8, ...(topics ? { topics: true } : {}) });
  }
  drop(): void {
    for (const listener of this.listeners.get('close') ?? []) listener({ code: 1006 });
  }
  topicFrames(): LiveClientFrame[] {
    return this.sent.filter((frame) => frame.k === 'topics.sub' || frame.k === 'topics.unsub');
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

async function harness() {
  const sockets: FakeSocket[] = [];
  const retries: (() => void)[] = [];
  const connection = new LiveConnection({
    baseUrl: 'https://core.example/',
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    getTicket: async () => 'ticket',
    scheduleReconnect: (run) => retries.push(run),
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  connection.start();
  await flush();
  return {
    connection,
    socket: () => sockets.at(-1)!,
    reconnect: async () => {
      retries.shift()?.();
      await flush();
    },
  };
}

function recorder() {
  const events: DomainEvent[] = [];
  const sink = {
    event: (event: DomainEvent) => events.push(event),
    resync: vi.fn<LiveTopicSink['resync']>(),
    ended: vi.fn<NonNullable<LiveTopicSink['ended']>>(),
  } satisfies LiveTopicSink;
  return { events, sink };
}

const change = (rev: number): DomainEvent => ({
  t: 'sandbox.update',
  projectId: 'p1',
  rev,
  available: true,
});

describe('LiveConnection topics', () => {
  it('subscribes once per topic however many views listen', async () => {
    const h = await harness();
    h.socket().ready(true);
    const a = recorder();
    const b = recorder();
    const detachA = h.connection.subscribeTopic('project:p1', a.sink);
    const detachB = h.connection.subscribeTopic('project:p1', b.sink);
    h.socket().serve({ k: 'domain', topic: 'project:p1', cursor: 5, event: change(1) });
    expect(a.events).toEqual([change(1)]);
    expect(b.events).toEqual([change(1)]);
    detachA();
    detachB();
    expect(h.socket().topicFrames()).toEqual([
      { k: 'topics.sub', topics: [{ topic: 'project:p1' }] },
      { k: 'topics.unsub', topics: ['project:p1'] },
    ]);
  });

  it('resumes from the last cursor after a reconnect and skips duplicates', async () => {
    const h = await harness();
    h.socket().ready(true);
    const view = recorder();
    h.connection.subscribeTopic('project:p1', view.sink);
    h.socket().serve({ k: 'domain', topic: 'project:p1', cursor: 7, event: change(1) });
    h.socket().drop();
    await h.reconnect();
    h.socket().ready(true);
    expect(h.socket().topicFrames()).toEqual([
      { k: 'topics.sub', topics: [{ topic: 'project:p1', cursor: 7 }] },
    ]);
    // A replay overlapping what was applied before the drop applies once.
    h.socket().serve({ k: 'domain', topic: 'project:p1', cursor: 7, event: change(1) });
    h.socket().serve({ k: 'domain', topic: 'project:p1', cursor: 8, event: change(2) });
    expect(view.events).toEqual([change(1), change(2)]);
    expect(view.sink.resync).not.toHaveBeenCalled();
  });

  it('subscribes topics added while disconnected once the server is ready', async () => {
    const h = await harness();
    const view = recorder();
    h.connection.subscribeTopic('project:p1', view.sink);
    expect(h.socket().topicFrames()).toEqual([]);
    h.socket().ready(true);
    expect(h.socket().topicFrames()).toEqual([
      { k: 'topics.sub', topics: [{ topic: 'project:p1' }] },
    ]);
  });

  it('retries a topic the server ended with a transient error', async () => {
    const h = await harness();
    h.socket().ready(true);
    const view = recorder();
    h.connection.subscribeTopic('project:p1', view.sink);
    h.socket().serve({ k: 'domain', topic: 'project:p1', cursor: 3, event: change(1) });
    h.socket().serve({ k: 'topic_ended', topic: 'project:p1', reason: 'error' });
    expect(view.sink.ended).not.toHaveBeenCalled();
    await h.reconnect(); // runs the scheduled retry
    expect(h.socket().topicFrames().at(-1)).toEqual({
      k: 'topics.sub',
      topics: [{ topic: 'project:p1', cursor: 3 }],
    });
  });

  it('turns a server resync into a snapshot reload and continues from its cursor', async () => {
    const h = await harness();
    h.socket().ready(true);
    const view = recorder();
    h.connection.subscribeTopic('project:p1', view.sink);
    h.socket().serve({ k: 'resync', topic: 'project:p1', cursor: 40 });
    expect(view.sink.resync).toHaveBeenCalledTimes(1);
    h.socket().drop();
    await h.reconnect();
    h.socket().ready(true);
    expect(h.socket().topicFrames()).toEqual([
      { k: 'topics.sub', topics: [{ topic: 'project:p1', cursor: 40 }] },
    ]);
  });

  it('tells views when a topic ends and forgets it', async () => {
    const h = await harness();
    h.socket().ready(true);
    const view = recorder();
    h.connection.subscribeTopic('project:p2', view.sink);
    h.socket().serve({ k: 'topic_ended', topic: 'project:p2', reason: 'forbidden' });
    expect(view.sink.ended).toHaveBeenCalledWith('forbidden');
    h.socket().serve({ k: 'domain', topic: 'project:p2', cursor: 9, event: change(1) });
    expect(view.events).toEqual([]);
  });

  it('reports a server without topics and sends it no topic frames', async () => {
    const h = await harness();
    const view = recorder();
    h.connection.subscribeTopic('project:p1', view.sink);
    h.socket().ready(false);
    expect(h.connection.topicsSupported).toBe(false);
    expect(h.socket().topicFrames()).toEqual([]);
    h.socket().drop();
    await h.reconnect();
    h.socket().ready(true);
    expect(h.connection.topicsSupported).toBe(true);
  });
});
