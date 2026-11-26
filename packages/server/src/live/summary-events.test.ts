import type { SessionRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../server-context.js';
import type { SessionSummary } from '../server-types.js';
import { DomainEventBus, type DomainRecord } from './domain-events.js';
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
  let observer: ((sessionId: string) => void) | undefined;
  const closers: Array<() => void> = [];
  const ctx = {
    deps: {
      bus: {
        subscribeAll: (fn: (sessionId: string) => void) => {
          observer = fn;
          return () => (observer = undefined);
        },
      },
      eventStore: {
        getSession: async (id: string) =>
          ({ sessionId: id, projectId: 'p1' }) as unknown as SessionRecord,
        wikiMaintenance: { isSession: async (id: string) => maintenance.has(id) },
      },
    },
    domainEvents,
    lifecycle: { onClose: (fn: () => void) => closers.push(fn) },
  } as unknown as Pick<ServerContext, 'deps' | 'domainEvents' | 'lifecycle'>;
  let current = rows[0]!;
  const summarize = vi.fn(async () => [current]);
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
    event: (sessionId = 's1') => observer?.(sessionId),
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

  it('marks a field the row no longer has as null', () => {
    expect(rowPatch({ a: 1, b: true }, { a: 1 })).toEqual({ b: null });
    expect(rowPatch({ a: 1 }, { a: 1 })).toBeUndefined();
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
