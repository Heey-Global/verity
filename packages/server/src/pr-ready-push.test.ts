import type { SessionRecord } from '@verity/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestStatus } from './github.js';
import { createPushForegroundPresence } from './push-fire-points.js';
import type { PushSender } from './push-sender.js';
import {
  buildPullRequestReadyNotification,
  pullRequestReadyMarker,
  startPullRequestReadyMonitor,
} from './pr-ready-push.js';

const SESSION: SessionRecord = {
  sessionId: 's1',
  worktree: '/wt/s1',
  model: 'm',
  name: 'Push polish',
  projectId: 'p1',
  kind: 'normal',
  lastSeenEventCount: null,
};

const READY: PullRequestStatus = {
  number: 831,
  title: 'feat(push): add merge action',
  url: 'https://github.test/pull/831',
  phase: 'open',
  updatedAt: '2026-07-14T12:00:00Z',
  headSha: 'abc123',
  pipeline: 'success',
  checks: { completed: 3, total: 3, successful: 3, failed: 0, pending: 0 },
  mergeable: true,
};

function fakeSender(): PushSender & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn().mockResolvedValue({
      targets: 1,
      ticketsAccepted: 1,
      ticketErrors: 0,
      receiptsQueued: 1,
      pruned: 0,
      transportErrors: 0,
    }),
    processDueReceipts: vi.fn().mockResolvedValue({}),
    start: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('pull request ready push', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('builds an actionable, contextual notification', () => {
    expect(
      buildPullRequestReadyNotification('s1', READY, {
        project: 'heey-global/verity',
        session: 'Push polish',
      }),
    ).toEqual({
      title: 'heey-global/verity · PR #831 ready',
      body: 'feat(push): add merge action · Push polish — all checks passed.',
      categoryId: 'PULL_REQUEST_READY',
      data: { sessionId: 's1', kind: 'pull_request_ready', pullRequestNumber: 831 },
      priority: 'high',
    });
    expect(pullRequestReadyMarker(READY)).toBe('pr-ready:831:abc123');
  });

  it('sends once per PR head and persists the dedupe marker', async () => {
    const sender = fakeSender();
    const markers = new Set<string>();
    const monitor = startPullRequestReadyMonitor({
      sender,
      presence: createPushForegroundPresence(),
      listSessions: async () => [SESSION],
      statusFor: async () => READY,
      wasSent: async (_sessionId, marker) => markers.has(marker),
      markSent: async (_sessionId, marker) => {
        markers.add(marker);
        return true;
      },
      describeSession: async () => ({ project: 'verity', session: 'Push polish' }),
      pollMs: 60_000,
    });
    await monitor.runOnce();
    await monitor.runOnce();
    expect(sender.send.mock.calls).toHaveLength(1);
    expect(markers).toContain('pr-ready:831:abc123');
    await monitor.stop();
  });

  it('waits while the session is visible and sends after it is closed', async () => {
    const sender = fakeSender();
    const presence = createPushForegroundPresence();
    const detach = presence.attach('s1');
    const monitor = startPullRequestReadyMonitor({
      sender,
      presence,
      listSessions: async () => [SESSION],
      statusFor: async () => READY,
      wasSent: async () => false,
      markSent: async () => true,
      describeSession: async () => ({}),
      pollMs: 60_000,
    });
    await monitor.runOnce();
    expect(sender.send.mock.calls).toHaveLength(0);
    detach();
    await monitor.runOnce();
    expect(sender.send.mock.calls).toHaveLength(1);
    await monitor.stop();
  });

  it('does not notify until checks pass and GitHub confirms mergeability', async () => {
    const sender = fakeSender();
    const statuses = [
      { ...READY, pipeline: 'running' as const, mergeable: null },
      { ...READY, pipeline: 'success' as const, mergeable: null },
      READY,
    ];
    const monitor = startPullRequestReadyMonitor({
      sender,
      presence: createPushForegroundPresence(),
      listSessions: async () => [SESSION],
      statusFor: async () => statuses.shift() ?? READY,
      wasSent: async () => false,
      markSent: async () => true,
      describeSession: async () => ({}),
      pollMs: 60_000,
    });
    await monitor.runOnce();
    await monitor.runOnce();
    expect(sender.send.mock.calls).toHaveLength(0);
    await monitor.runOnce();
    expect(sender.send.mock.calls).toHaveLength(1);
    await monitor.stop();
  });

  it('removes the marker after a send failure so a later poll retries', async () => {
    const sender = fakeSender();
    sender.send.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      targets: 1,
      ticketsAccepted: 1,
      ticketErrors: 0,
      receiptsQueued: 1,
      pruned: 0,
      transportErrors: 0,
    });
    let marked = false;
    const monitor = startPullRequestReadyMonitor({
      sender,
      presence: createPushForegroundPresence(),
      listSessions: async () => [SESSION],
      statusFor: async () => READY,
      wasSent: async () => marked,
      markSent: async () => {
        marked = true;
        return true;
      },
      describeSession: async () => ({}),
      pollMs: 60_000,
    });
    await monitor.runOnce();
    await monitor.runOnce();
    expect(sender.send.mock.calls).toHaveLength(2);
    await monitor.stop();
  });

  it('stays eligible when no device is registered yet', async () => {
    const sender = fakeSender();
    sender.send
      .mockResolvedValueOnce({
        targets: 0,
        ticketsAccepted: 0,
        ticketErrors: 0,
        receiptsQueued: 0,
        pruned: 0,
        transportErrors: 0,
      })
      .mockResolvedValueOnce({
        targets: 1,
        ticketsAccepted: 1,
        ticketErrors: 0,
        receiptsQueued: 1,
        pruned: 0,
        transportErrors: 0,
      });
    let marked = false;
    const monitor = startPullRequestReadyMonitor({
      sender,
      presence: createPushForegroundPresence(),
      listSessions: async () => [SESSION],
      statusFor: async () => READY,
      wasSent: async () => marked,
      markSent: async () => {
        marked = true;
        return true;
      },
      describeSession: async () => ({}),
      pollMs: 60_000,
    });
    await monitor.runOnce();
    await monitor.runOnce();
    expect(sender.send.mock.calls).toHaveLength(2);
    expect(marked).toBe(true);
    await monitor.stop();
  });

  // The monitor is driven by `setInterval(() => void runOnce(), …)`, so nothing
  // is ever there to receive a rejection from a poll. `listSessions` is the one
  // step outside the per-session guard and the only one that reaches the
  // control-plane database, so when PostgreSQL went away it took the Server's
  // process down with it — a notification poller cancelling out the reconnect
  // budget the control plane is given for exactly that outage.
  it('survives a listSessions failure instead of rejecting a poll nothing awaits', async () => {
    const sender = fakeSender();
    const warn = vi.fn();
    const monitor = startPullRequestReadyMonitor({
      sender,
      presence: createPushForegroundPresence(),
      listSessions: async () => {
        throw new Error('getaddrinfo ENOTFOUND verity-postgres');
      },
      statusFor: async () => READY,
      wasSent: async () => false,
      markSent: async () => true,
      describeSession: async () => ({}),
      logger: { info: vi.fn(), warn },
      pollMs: 60_000,
    });
    // Resolving is the assertion: this is the very promise the interval
    // discards, so a rejection surviving here is an unhandled rejection there.
    await expect(monitor.runOnce()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { component: 'push', kind: 'pull_request_ready' },
      'verity: PR-ready poll could not list sessions',
    );
    expect(sender.send.mock.calls).toHaveLength(0);
    // The outage is transient by nature, so the monitor must still be willing
    // to poll rather than have latched itself off on the way past.
    await expect(monitor.runOnce()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    // `stop()` joins the batch in flight, so it is the second place the same
    // rejection would have escaped to.
    await expect(monitor.stop()).resolves.toBeUndefined();
  });
});
