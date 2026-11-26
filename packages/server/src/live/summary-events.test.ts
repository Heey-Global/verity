import type { SessionRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../server-context.js';
import type { SessionSummary } from '../server-types.js';
import { InMemoryEventBus } from '@verity/session';
import type { AgentEvent } from '@verity/events';
import { DomainEventBus, type DomainRecord } from './domain-events.js';
import { LiveHub } from './live-hub.js';
import type { LiveHubChange } from './live-hub.js';
import { installSummaryEvents, sharedRow } from './summary-events.js';

function summary(extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 's1',
    projectId: 'p1',
    status: 'running',
    eventCount: 1,
    lastActivityAt: 1,
    ...extra,
  } as SessionSummary;
}

function setup(rows: SessionSummary[], maintenance: ReadonlySet<string> = new Set()) {
  const domainEvents = new DomainEventBus();
  let observer: ((change: LiveHubChange) => void) | undefined;
  let failing = 0;
  const closers: Array<() => void> = [];
  const ctx = {
    deps: {
      eventStore: {
        getSession: async (id: string) =>
          ({ sessionId: id, projectId: 'p1' }) as unknown as SessionRecord,
        wikiMaintenance: { isSession: async (id: string) => maintenance.has(id) },
      },
    },
    domainEvents,
    lifecycle: { onClose: (fn: () => void) => closers.push(fn) },
    liveHub: {
      onNotify: (fn: (change: LiveHubChange) => void) => {
        observer = fn;
        return () => (observer = undefined);
      },
    },
  } as unknown as Pick<ServerContext, 'deps' | 'domainEvents' | 'lifecycle' | 'liveHub'>;
  let current = rows[0]!;
  const summarize = vi.fn(async () => {
    if (failing > 0) {
      failing -= 1;
      throw new Error('store unavailable');
    }
    return [current];
  });
  let now = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const installed = installSummaryEvents({ log: { warn: () => undefined } }, ctx, summarize, {
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => now,
  });
  const published: DomainRecord[] = [];
  const record = (topic: `session:${string}` | `project:${string}`) =>
    domainEvents.subscribe(topic, undefined, (r) => published.push(r));
  return {
    summaryRevision: installed.summaryRevision,
    published,
    record,
    summarize,
    event: (topics: LiveHubChange['topics'] = ['events', 'status'], sessionId = 's1') =>
      observer?.({ sessionId, topics }),
    fail: (times: number) => (failing = times),
    set: (next: SessionSummary) => (current = next),
    advance: (ms: number) => {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
    close: () => closers.forEach((fn) => fn()),
  };
}

describe('session.summary', () => {
  it('publishes the whole row once per burst', async () => {
    const w = setup([summary()]);
    w.record('project:p1');
    w.event();
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    expect(w.summarize).toHaveBeenCalledTimes(1);
    expect(w.published[0]!.event).toMatchObject({
      t: 'session.summary',
      sessionId: 's1',
      patch: { status: 'running', eventCount: 1 },
    });

    w.set(summary({ status: 'idle', eventCount: 2 }));
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.published).toHaveLength(2));
    expect((w.published[1]!.event as { patch: object }).patch).toEqual({
      status: 'idle',
      eventCount: 2,
      lastActivityAt: 1,
    });
    // Unchanged since the last row, it still goes out: a view may hold a state
    // its own read took in between, which a hint would have corrected.
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.published).toHaveLength(3));
    w.close();
  });

  // Streaming text keeps scheduling the row; it must still go out while the
  // burst lasts, not only when it ends.
  it('publishes a long burst at least every two seconds', async () => {
    const w = setup([summary()]);
    w.record('project:p1');
    for (let elapsed = 0; elapsed < 2_000; elapsed += 100) {
      w.event();
      w.advance(100);
    }
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    w.close();
  });

  it('leaves out what each viewer sees differently and what other events own', () => {
    const row = sharedRow(
      summary({
        lastSeenEventCount: 3,
        inboxDismissed: ['x'],
        pendingPermissions: ['t'],
        pr: null,
        planning: 'active',
        planningPlan: 'long plan text',
      }),
    );
    expect(row).not.toHaveProperty('lastSeenEventCount');
    expect(row).not.toHaveProperty('inboxDismissed');
    expect(row).not.toHaveProperty('pendingPermissions');
    expect(row).not.toHaveProperty('pr');
    expect(row).not.toHaveProperty('planningPlan');
    expect(row).toMatchObject({ planningPresented: true, status: 'running' });
  });

  // Only named fields leave the server: a field added to the row later is
  // not published until someone decides it may be.
  it('carries only the fields every viewer sees alike', () => {
    const row = sharedRow(summary({ worktree: '/wt/secret', favorite: true }));
    expect(Object.keys(row).sort()).toEqual(['eventCount', 'lastActivityAt', 'status']);
  });

  // Home skips its list read for these hints, whatever raised them.
  it('publishes for every status or transcript hint and for no other', async () => {
    const w = setup([summary()]);
    w.record('project:p1');
    w.event(['session']);
    w.event(['activity']);
    w.advance(2_000);
    // Time for a computation that should not run to have run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.summarize).not.toHaveBeenCalled();
    w.event(['status']);
    w.advance(300);
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    w.close();
  });

  // The hint that scheduled the row may be the last one of the session.
  it('tries a row again that could not be computed', async () => {
    const w = setup([summary()]);
    w.record('project:p1');
    w.fail(1);
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.summarize).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    w.advance(2_000);
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    w.close();
  });

  it('keeps Wiki maintenance sessions to their own topic', async () => {
    const w = setup([summary()], new Set(['s1']));
    w.record('session:s1');
    w.record('project:p1');
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    expect(w.published[0]!.topic).toBe('session:s1');
    w.close();
  });

  // Home skips its read for every status or transcript hint of a followed
  // project; the hint of a plain agent event must therefore bring a row too.
  it('publishes for an agent event the live hub hints', async () => {
    const bus = new InMemoryEventBus();
    const domainEvents = new DomainEventBus();
    const hub = new LiveHub({
      bus,
      store: { getSession: async () => undefined, getEventsAfter: async () => [] },
      access: {
        canReadSession: async () => true,
        overviewScope: async () => ({ all: true }),
      },
      domainEvents,
    });
    const closers: Array<() => void> = [];
    const ctx = {
      deps: {
        eventStore: {
          getSession: async (id: string) =>
            ({ sessionId: id, projectId: 'p1' }) as unknown as SessionRecord,
          wikiMaintenance: { isSession: async () => false },
        },
      },
      domainEvents,
      lifecycle: { onClose: (fn: () => void) => closers.push(fn) },
      liveHub: hub,
    } as unknown as Pick<ServerContext, 'deps' | 'domainEvents' | 'lifecycle' | 'liveHub'>;
    installSummaryEvents({ log: { warn: () => undefined } }, ctx, async () => [summary()]);
    const published: DomainRecord[] = [];
    domainEvents.subscribe('project:p1', undefined, (r) => published.push(r));
    bus.publish('s1', { seq: 1, ts: 1, event: { t: 'text', delta: 'hi' } satisfies AgentEvent });
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]!.event).toMatchObject({ t: 'session.summary', sessionId: 's1' });
    closers.forEach((fn) => fn());
    hub.close();
  });

  // A list read that took its revisions while this row was being computed
  // holds a later state; the row must not order after it.
  it('takes the revision before computing the row', async () => {
    const w = setup([summary()]);
    w.record('project:p1');
    let finish: () => void = () => undefined;
    w.summarize.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve([summary()]))),
    );
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.summarize).toHaveBeenCalledTimes(1));
    const computing = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 30));
    finish();
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    expect((w.published[0]!.event as { rev: number }).rev).toBeLessThanOrEqual(computing);
    w.close();
  });

  // A list read that begins while a row is computed is as new as that row; it
  // must carry the row's revision so views drop the row over it.
  it('stamps reads with the revision of a row still being computed', async () => {
    const w = setup([summary()]);
    w.record('project:p1');
    let finish: () => void = () => undefined;
    w.summarize.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve([summary()]))),
    );
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.summarize).toHaveBeenCalledTimes(1));
    const stamped = w.summaryRevision('s1');
    expect(stamped).toBeDefined();
    finish();
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    expect((w.published[0]!.event as { rev: number }).rev).toBe(stamped);
    w.close();
  });
});
