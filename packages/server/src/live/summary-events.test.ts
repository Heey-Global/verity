import type { SessionRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../server-context.js';
import type { SessionSummary } from '../server-types.js';
import { DomainEventBus, type DomainRecord } from './domain-events.js';
import type { LiveHubChange } from './live-hub.js';
import { installSummaryEvents, rowPatch, sharedRow } from './summary-events.js';

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
  installSummaryEvents({ log: { warn: () => undefined } }, ctx, summarize, {
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
  it('publishes the row once per burst, then only what changed', async () => {
    const w = setup([summary()]);
    w.record('project:p1');
    w.event();
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    expect(w.summarize).toHaveBeenCalledTimes(1);
    // The first row is whole: views holding the session read it again.
    expect(w.published[0]!.event).toMatchObject({
      t: 'session.summary',
      sessionId: 's1',
      full: true,
      patch: { status: 'running', eventCount: 1 },
    });

    w.set(summary({ status: 'idle', eventCount: 2 }));
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.published).toHaveLength(2));
    expect(w.published[1]!.event).not.toHaveProperty('full');
    expect((w.published[1]!.event as { patch: object }).patch).toEqual({
      status: 'idle',
      eventCount: 2,
    });
    // Nothing changed: nothing published.
    w.event();
    w.advance(300);
    await vi.waitFor(() => expect(w.summarize).toHaveBeenCalledTimes(3));
    expect(w.published).toHaveLength(2);
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

  // `null` is a value some fields have; a field that is gone is named apart.
  it('names the fields the row no longer has', () => {
    expect(rowPatch({ a: 1, b: true }, { a: 1, c: null })).toEqual({
      patch: { c: null },
      unset: ['b'],
    });
    expect(rowPatch({ a: 1 }, { a: 1 })).toBeUndefined();
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
});
