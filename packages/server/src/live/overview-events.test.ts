import type { AgentEvent, LiveServerFrame } from '@verity/events';
import { InMemoryEventBus } from '@verity/session';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../server-context.js';
import { DomainEventBus, type DomainRecord } from './domain-events.js';
import { LiveHub, type LiveSocket } from './live-hub.js';
import { installOverviewEvents } from './overview-events.js';

type Decide = ServerContext['conductor']['decidePermission'];

/** Like the conductor: a standing grant answers through its own method. */
class FakeConductor {
  accept = true;
  readonly calls: string[] = [];
  decidePermission: Decide = async (_sessionId, toolUseId) => {
    this.calls.push(toolUseId);
    return this.accept;
  };
  async autoApprove(sessionId: string, toolUseId: string): Promise<void> {
    await this.decidePermission(
      sessionId,
      toolUseId,
      { behavior: 'allow' },
      { decidedBy: 'grant' },
    );
  }
}

function setup() {
  const bus = new InMemoryEventBus();
  const domainEvents = new DomainEventBus();
  const conductor = new FakeConductor();
  const closers: (() => unknown)[] = [];
  const sessions = new Map([
    ['s1', { sessionId: 's1', projectId: 'p1' }],
    ['s0', { sessionId: 's0', projectId: null }],
  ]);
  const ctx = {
    deps: { bus, eventStore: { getSession: async (id: string) => sessions.get(id) } },
    domainEvents,
    conductor,
    lifecycle: { onClose: (stop: () => unknown) => closers.push(stop) },
  } as unknown as ServerContext;
  installOverviewEvents({ log: { warn: () => undefined } }, ctx);
  const published: DomainRecord[] = [];
  const record = (topic: 'project:p1' | 'session:s1' | 'session:s0') =>
    domainEvents.subscribe(topic, undefined, (r) => published.push(r));
  let seq = 0;
  const emit = (sessionId: string, event: AgentEvent) =>
    bus.publish(sessionId, { seq: ++seq, ts: seq, event });
  return { bus, domainEvents, conductor, ctx, published, record, emit, closers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('installOverviewEvents', () => {
  it('announces requests and questions on the project and session topics', async () => {
    const w = setup();
    w.record('project:p1');
    w.record('session:s1');
    w.emit('s1', { t: 'permission', id: 'tool-1', tool: 'Bash', input: {}, riskClass: 'ask' });
    w.emit('s1', { t: 'choices', options: [{ label: 'Ship it' }] });
    w.emit('s1', { t: 'prompt', text: 'Ship it' });
    w.emit('s1', { t: 'prompt', text: 'also this', steered: true });
    w.emit('s1', { t: 'text', delta: 'not an overview change' });
    // No question is open any more: a further prompt announces nothing.
    w.emit('s1', { t: 'prompt', text: 'next task' });
    await settle();
    const byTopic = (topic: string) =>
      w.published.filter((r) => r.topic === topic).map((r) => r.event.t);
    expect(byTopic('project:p1')).toEqual([
      'permission.requested',
      'choices.opened',
      'choices.answered',
    ]);
    expect(byTopic('session:s1')).toEqual(byTopic('project:p1'));
    // Ids only: the request's tool and input stay behind the overview read.
    expect(w.published[0]?.event).toEqual({
      t: 'permission.requested',
      sessionId: 's1',
      toolUseId: 'tool-1',
      rev: expect.any(Number),
    });
  });

  it('publishes a project-less session on its session topic only', async () => {
    const w = setup();
    w.record('session:s0');
    w.emit('s0', { t: 'choices', options: [{ label: 'Yes' }] });
    await settle();
    expect(w.published.map((r) => r.topic)).toEqual(['session:s0']);
  });

  it('reports accepted decisions, including those a standing grant makes', async () => {
    const w = setup();
    w.record('project:p1');
    await w.ctx.conductor.decidePermission('s1', 'card', { behavior: 'deny', message: 'no' });
    await w.conductor.autoApprove('s1', 'granted');
    w.conductor.accept = false;
    await w.ctx.conductor.decidePermission('s1', 'stale', { behavior: 'allow' });
    await settle();
    expect(w.conductor.calls).toEqual(['card', 'granted', 'stale']);
    expect(w.published.map((r) => r.event)).toEqual([
      expect.objectContaining({ t: 'permission.decided', toolUseId: 'card', outcome: 'denied' }),
      expect.objectContaining({
        t: 'permission.decided',
        toolUseId: 'granted',
        outcome: 'allowed',
      }),
    ]);
  });

  it('orders revisions of one session', async () => {
    // Project lookups that resolve out of order must not reorder publication.
    const w = setup();
    let lookups = 0;
    (w.ctx.deps.eventStore as { getSession: (id: string) => Promise<unknown> }).getSession = (id) =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ sessionId: id, projectId: 'p1' }), 30 - 10 * lookups++),
      );
    w.record('session:s1');
    for (let i = 0; i < 3; i += 1) w.emit('s1', { t: 'choices', options: [{ label: 'x' }] });
    await vi.waitFor(() => expect(w.published).toHaveLength(3));
    const revs = w.published.map((r) => r.event.rev);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(3);
  });

  it("removes an answered card from another device's live connection", async () => {
    // Device A answers; device B, subscribed to the project, hears it at once.
    const w = setup();
    const hub = new LiveHub({
      bus: w.bus,
      store: {
        getSession: async (id) => (id === 's1' ? { sessionId: 's1', projectId: 'p1' } : undefined),
        getEventsAfter: async () => [],
      },
      access: {
        canReadSession: async () => true,
        overviewScope: async () => ({ all: false, projectIds: new Set(['p1']), unassigned: false }),
      },
      domainEvents: w.domainEvents,
    });
    const frames: LiveServerFrame[] = [];
    const listeners = new Map<string, ((data?: unknown) => void)[]>();
    const socket: LiveSocket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (data) => frames.push(JSON.parse(data) as LiveServerFrame),
      close: () => undefined,
      terminate: () => undefined,
      ping: () => undefined,
      on: (event: string, listener: (data?: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return socket;
      },
    };
    hub.attach(socket, { userId: 'bob', deviceId: 'device-b' });
    for (const listener of listeners.get('message') ?? [])
      listener(JSON.stringify({ k: 'topics.sub', topics: [{ topic: 'project:p1' }] }));
    await vi.waitFor(() => expect(frames.some((f) => f.k === 'resync')).toBe(true));
    const started = Date.now();
    await w.ctx.conductor.decidePermission('s1', 'tool-1', { behavior: 'allow' });
    await vi.waitFor(() =>
      expect(frames.filter((f) => f.k === 'domain')).toEqual([
        expect.objectContaining({
          topic: 'project:p1',
          event: expect.objectContaining({ t: 'permission.decided', toolUseId: 'tool-1' }),
        }),
      ]),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    hub.close();
  });

  it('installs on a composition whose conductor handles no permissions', () => {
    // Narrow servers pass an empty conductor; building them must not throw.
    const ctx = {
      deps: { bus: new InMemoryEventBus(), eventStore: { getSession: async () => undefined } },
      domainEvents: new DomainEventBus(),
      conductor: {},
      lifecycle: { onClose: () => undefined },
    } as unknown as ServerContext;
    expect(() => installOverviewEvents({ log: { warn: () => undefined } }, ctx)).not.toThrow();
  });

  it('stops translating session events when the server closes', async () => {
    const w = setup();
    w.record('project:p1');
    for (const close of w.closers) close();
    w.emit('s1', { t: 'choices', options: [{ label: 'x' }] });
    await settle();
    expect(w.published).toEqual([]);
  });

  it('hands the conductor its own decision method back when the server closes', async () => {
    // A conductor outliving this server would otherwise keep publishing to a
    // closed bus, and a second server would wrap the wrapper.
    const w = setup();
    w.record('project:p1');
    for (const close of w.closers) close();
    await w.ctx.conductor.decidePermission('s1', 'tool-1', { behavior: 'allow' });
    await settle();
    expect(w.conductor.calls).toEqual(['tool-1']);
    expect(w.published).toEqual([]);
  });

  it('keeps publishing a session after one project lookup fails', async () => {
    const w = setup();
    w.record('session:s1');
    let calls = 0;
    (w.ctx.deps.eventStore as { getSession: (id: string) => Promise<unknown> }).getSession = (
      id,
    ) =>
      calls++ === 0
        ? Promise.resolve().then(() => {
            throw new Error('store down');
          })
        : Promise.resolve({ sessionId: id, projectId: 'p1' });
    w.emit('s1', { t: 'choices', options: [{ label: 'x' }] });
    w.emit('s1', { t: 'choices', options: [{ label: 'y' }] });
    await vi.waitFor(() => expect(w.published).toHaveLength(2));
  });
});
