import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary, VerityClient } from '../api.js';
import { inboxItems } from '../ui/inbox.js';
import { SessionListModel } from './sessionList.js';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    worktree: `/wt/${id}`,
    model: 'm',
    name: null,
    status: 'running',
    usage,
    ...extra,
  };
}

function clientFor(listSessions: () => Promise<SessionSummary[]>): VerityClient {
  return {
    listSessions,
    listProviderLimits: () => Promise.resolve([]),
    renameSession: vi.fn(),
    setSessionFavorite: vi.fn(),
    deleteSession: vi.fn(),
  } as unknown as VerityClient;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionListModel.settlePermission', () => {
  it('removes the Home inbox card of the answered request, not only its id', async () => {
    // Home renders permission cards from `pendingPermissionRequests`; settling
    // only `pendingPermissions` left an answered secret request on Home until
    // the next full list read.
    const listSessions = vi.fn(() =>
      Promise.resolve([
        summary('s1', {
          status: 'awaiting_input',
          permissionAwaitingInput: true,
          pendingPermissions: ['tool-a'],
          pendingPermissionRequests: [
            { toolUseId: 'tool-a', tool: 'Bash', riskClass: 'secret', detached: true },
          ],
        }),
      ]),
    );
    const model = new SessionListModel({ client: clientFor(listSessions) });
    await model.refresh();
    const cards = () =>
      inboxItems({ sessions: model.state.sessions, projects: [], now: 0 }).filter(
        (item) => item.kind === 'permission',
      );
    expect(cards()).toHaveLength(1);

    model.settlePermission('s1', 'tool-a');

    expect(cards()).toHaveLength(0);
    expect(model.state.sessions[0]).toMatchObject({
      status: 'running',
      pendingPermissions: [],
      pendingPermissionRequests: [],
    });
  });
});

describe('SessionListModel.applyHints', () => {
  it('spaces reloads caused only by transcript growth', async () => {
    vi.useFakeTimers();
    let now = 0;
    const listSessions = vi.fn(() => Promise.resolve([summary('s1')]));
    const model = new SessionListModel({
      client: clientFor(listSessions),
      pollIntervalMs: 0,
      eventsRefreshMs: 10_000,
      now: () => now,
    });
    model.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listSessions).toHaveBeenCalledTimes(1);

    // A streaming turn: one `events` hint per coalescing window.
    for (let i = 0; i < 20; i += 1) {
      model.applyHints([{ sessionId: 's1', topics: ['events'] }]);
      now += 250;
      await vi.advanceTimersByTimeAsync(250);
    }
    // 5 s of streaming: the first hint reloads at once, the rest wait for the
    // spacing to elapse instead of re-reading the list 20 times.
    expect(listSessions).toHaveBeenCalledTimes(2);

    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listSessions).toHaveBeenCalledTimes(3);
    model.stop();
  });

  it('reloads at once for status, permission and session hints', async () => {
    vi.useFakeTimers();
    const listSessions = vi.fn(() => Promise.resolve([summary('s1')]));
    const model = new SessionListModel({
      client: clientFor(listSessions),
      pollIntervalMs: 0,
      now: () => 0,
    });
    model.start();
    await vi.advanceTimersByTimeAsync(0);
    model.applyHints([{ sessionId: 's1', topics: ['events'] }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(listSessions).toHaveBeenCalledTimes(2);

    for (const topic of ['status', 'permission', 'session'] as const) {
      const before = listSessions.mock.calls.length;
      model.applyHints([{ sessionId: 's1', topics: ['events', topic] }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(listSessions).toHaveBeenCalledTimes(before + 1);
    }
    model.stop();
  });

  it('drops a pending transcript reload when the model stops', async () => {
    vi.useFakeTimers();
    let now = 0;
    const listSessions = vi.fn(() => Promise.resolve([summary('s1')]));
    const model = new SessionListModel({
      client: clientFor(listSessions),
      pollIntervalMs: 0,
      now: () => now,
    });
    model.start();
    await vi.advanceTimersByTimeAsync(0);
    model.applyHints([{ sessionId: 's1', topics: ['events'] }]);
    model.applyHints([{ sessionId: 's1', topics: ['events'] }]);
    await vi.advanceTimersByTimeAsync(0);
    const calls = listSessions.mock.calls.length;
    model.stop();
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listSessions).toHaveBeenCalledTimes(calls);
  });
});
