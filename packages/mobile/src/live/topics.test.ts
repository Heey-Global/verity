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
  ready(topics: boolean, topicEpoch = 'epoch-1'): void {
    this.serve({
      k: 'ready',
      v: 2,
      maxSessions: 8,
      ...(topics ? { topics: true, topicEpoch } : {}),
    });
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

  it('drops cursors of another server epoch instead of resuming from them', async () => {
    // A restarted server (or one whose clock stepped back) never handed out
    // these positions; resuming from them could skip changes silently.
    const h = await harness();
    h.socket().ready(true, 'epoch-1');
    const view = recorder();
    h.connection.subscribeTopic('project:p1', view.sink);
    h.socket().serve({ k: 'domain', topic: 'project:p1', cursor: 7, event: change(1) });
    h.socket().drop();
    await h.reconnect();
    h.socket().ready(true, 'epoch-2');
    expect(h.socket().topicFrames()).toEqual([
      { k: 'topics.sub', topics: [{ topic: 'project:p1' }] },
    ]);
  });

  it('backs off retries while a topic keeps failing', async () => {
    const delays: number[] = [];
    const connection = new LiveConnection({
      baseUrl: 'https://core.example/',
      connect: () => socket,
      getTicket: async () => 'ticket',
      scheduleReconnect: (_run, delayMs) => delays.push(delayMs),
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    const socket = new FakeSocket();
    connection.start();
    await flush();
    socket.ready(true);
    connection.subscribeTopic('project:p1', recorder().sink);
    for (let i = 0; i < 6; i += 1)
      socket.serve({ k: 'topic_ended', topic: 'project:p1', reason: 'error' });
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    // A new connection starts the backoff over.
    socket.ready(true);
    socket.serve({ k: 'topic_ended', topic: 'project:p1', reason: 'error' });
    expect(delays.at(-1)).toBe(5_000);
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

describe('LiveConnection.followsTopic', () => {
  // Home skips its list read for status hints of a followed project; with a
  // server that never sends `session.summary`, statuses would then never change.
  it('follows a live topic only once the server has sent a session summary', async () => {
    const h = await harness();
    h.socket().ready(true);
    const { sink } = recorder();
    h.connection.subscribeTopic('project:p1', sink);
    h.socket().serve({ k: 'resync', topic: 'project:p1', cursor: 3 });
    expect(h.connection.followsTopic('project:p1')).toBe(false);
    h.socket().serve({
      k: 'domain',
      topic: 'project:p1',
      cursor: 4,
      event: { t: 'session.summary', sessionId: 's1', rev: 1, patch: { status: 'idle' } },
    });
    expect(h.connection.followsTopic('project:p1')).toBe(true);
    expect(h.connection.followsTopic('project:p2')).toBe(false);

    // Dropped: nothing arrives until the connection is back.
    h.socket().drop();
    expect(h.connection.followsTopic('project:p1')).toBe(false);
    // Another server process may be an older one.
    await h.reconnect();
    h.socket().ready(true, 'epoch-2');
    h.socket().serve({ k: 'resync', topic: 'project:p1', cursor: 1 });
    expect(h.connection.followsTopic('project:p1')).toBe(false);
  });

  // Resumed from its cursor, the topic may still fail; until the server
  // answers, hints of its sessions must not be skipped.
  it('follows a resumed topic again only once the server answers it', async () => {
    const h = await harness();
    h.socket().ready(true);
    const { sink } = recorder();
    h.connection.subscribeTopic('project:p1', sink);
    const summary = (cursor: number) =>
      h.socket().serve({
        k: 'domain',
        topic: 'project:p1',
        cursor,
        event: { t: 'session.summary', sessionId: 's1', rev: cursor, patch: {} },
      });
    summary(4);
    expect(h.connection.followsTopic('project:p1')).toBe(true);
    h.socket().drop();
    await h.reconnect();
    h.socket().ready(true);
    expect(h.connection.followsTopic('project:p1')).toBe(false);
    summary(5);
    expect(h.connection.followsTopic('project:p1')).toBe(true);
  });
});

describe('LiveConnection.onTopicsChanged', () => {
  // Views stop watching their routes while their topics are followed. A topic
  // that stops being followed without a read following it (the limit, an
  // error, a view releasing it, a dropped socket) must be reported, or the
  // view would hear of nothing until it happens to read again.
  it('reports every change of what a topic follows, and nothing for plain events', async () => {
    const h = await harness();
    let calls = 0;
    h.connection.onTopicsChanged(() => (calls += 1));
    const step = (run: () => void) => {
      const before = h.connection.followsTopic('project:p1');
      calls = 0;
      run();
      const after = h.connection.followsTopic('project:p1');
      if (after !== before) expect(calls).toBeGreaterThan(0);
      return after;
    };
    const summary = (cursor: number) =>
      h.socket().serve({
        k: 'domain',
        topic: 'project:p1',
        cursor,
        event: { t: 'session.summary', sessionId: 's1', rev: cursor, patch: {} },
      });
    step(() => h.socket().ready(true));
    const { sink } = recorder();
    let release = () => undefined as void;
    step(() => (release = h.connection.subscribeTopic('project:p1', sink)));
    expect(calls).toBeGreaterThan(0);
    expect(step(() => summary(1))).toBe(true);
    // Followed already: an event changes nothing a view decides on.
    step(() => summary(2));
    expect(calls).toBe(0);
    expect(step(() => h.socket().drop())).toBe(false);
    await h.reconnect();
    step(() => h.socket().ready(true));
    expect(step(() => summary(3))).toBe(true);
    expect(
      step(() => h.socket().serve({ k: 'topic_ended', topic: 'project:p1', reason: 'error' })),
    ).toBe(false);
    expect(step(() => summary(4))).toBe(true);
    expect(
      step(() => h.socket().serve({ k: 'topic_ended', topic: 'project:p1', reason: 'limit' })),
    ).toBe(false);
    step(() => (release = h.connection.subscribeTopic('project:p1', sink)));
    expect(step(() => summary(5))).toBe(true);
    step(() => release());
    expect(calls).toBeGreaterThan(0);
  });

  // A topic answered with `resync` counts as followed only once this server
  // has sent any session row, which may arrive on another topic.
  it('reports topics the first session row makes followed', async () => {
    const h = await harness();
    h.socket().ready(true);
    const { sink } = recorder();
    h.connection.subscribeTopic('project:p1', sink);
    h.connection.subscribeTopic('project:p2', sink);
    h.socket().serve({ k: 'resync', topic: 'project:p2', cursor: 1 });
    expect(h.connection.followsTopic('project:p2')).toBe(false);
    const changed = vi.fn();
    h.connection.onTopicsChanged(changed);
    h.socket().serve({ k: 'resync', topic: 'project:p1', cursor: 2 });
    changed.mockClear();
    h.socket().serve({
      k: 'domain',
      topic: 'project:p1',
      cursor: 3,
      event: { t: 'session.summary', sessionId: 's1', rev: 1, patch: {} },
    });
    expect(h.connection.followsTopic('project:p2')).toBe(true);
    expect(changed).toHaveBeenCalled();
  });
});
