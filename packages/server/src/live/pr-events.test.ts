import type { SessionRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { PullRequestStatus } from '../forge-provider.js';
import type { ServerContext } from '../server-context.js';
import { DomainEventBus, type DomainRecord } from './domain-events.js';
import { createPrEvents } from './pr-events.js';

const open: PullRequestStatus = {
  number: 7,
  title: 'Add live status',
  url: 'https://example.test/pr/7',
  phase: 'open',
  pipeline: 'running',
  mergeable: null,
  checks: { completed: 0, total: 1, successful: 0, failed: 0, pending: 1 },
};
const green: PullRequestStatus = {
  ...open,
  pipeline: 'success',
  mergeable: true,
  checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
};

function session(sessionId: string, projectId: string | null): SessionRecord {
  return { sessionId, projectId, worktree: `/wt/${sessionId}` } as SessionRecord;
}

function setup(maintenance: ReadonlySet<string> = new Set()) {
  const domainEvents = new DomainEventBus();
  const ctx = {
    deps: {
      eventStore: { wikiMaintenance: { isSession: async (id: string) => maintenance.has(id) } },
    },
    domainEvents,
  } as unknown as Pick<ServerContext, 'deps' | 'domainEvents'>;
  const onStatus = createPrEvents({ log: { warn: () => undefined } }, ctx);
  const published: DomainRecord[] = [];
  const record = (topic: `session:${string}` | `project:${string}`) =>
    domainEvents.subscribe(topic, undefined, (r) => published.push(r));
  return { onStatus, published, record };
}

describe('createPrEvents', () => {
  it('publishes each change of a session pull request once, in order, on both topics', async () => {
    const w = setup();
    w.record('session:s1');
    w.record('project:p1');
    const s1 = session('s1', 'p1');
    w.onStatus(s1, open);
    // The same status read again by another source is not news.
    w.onStatus(s1, { ...open });
    w.onStatus(s1, green);
    w.onStatus(s1, null);
    await vi.waitFor(() => expect(w.published).toHaveLength(6));
    const onProject = w.published.filter((r) => r.topic === 'project:p1').map((r) => r.event);
    expect(onProject).toEqual([
      expect.objectContaining({ t: 'pr.status', sessionId: 's1', pr: open }),
      expect.objectContaining({ t: 'pr.status', sessionId: 's1', pr: green }),
      expect.objectContaining({ t: 'pr.status', sessionId: 's1', pr: null }),
    ]);
    const revs = onProject.map((event) => event.rev);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
  });

  it('keeps Wiki maintenance sessions, which the list leaves out, off the project topic', async () => {
    const w = setup(new Set(['wiki']));
    w.record('session:wiki');
    w.record('project:p1');
    w.onStatus(session('wiki', 'p1'), open);
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    expect(w.published[0]!.topic).toBe('session:wiki');
  });

  it('publishes sessions without a project on their own topic only', async () => {
    const w = setup();
    w.record('session:s0');
    w.record('project:p1');
    w.onStatus(session('s0', null), open);
    await vi.waitFor(() => expect(w.published).toHaveLength(1));
    expect(w.published[0]!.topic).toBe('session:s0');
  });
});
