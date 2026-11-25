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
    // 5 s of streaming right after the initial read: the hints wait for the
    // spacing to elapse instead of re-reading the list 20 times.
    expect(listSessions).toHaveBeenCalledTimes(1);

    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listSessions).toHaveBeenCalledTimes(2);

    // Once the spacing has passed since the last read, growth reloads at once.
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    model.applyHints([{ sessionId: 's1', topics: ['events'] }]);
    await vi.advanceTimersByTimeAsync(0);
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
    // Transcript growth right after a read waits for the spacing…
    expect(listSessions).toHaveBeenCalledTimes(1);

    // …but anything else reloads at once.
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

describe('SessionListModel.applyDomainEvent', () => {
  const waiting = () =>
    summary('s1', {
      status: 'awaiting_input',
      permissionAwaitingInput: true,
      pendingPermissions: ['tool-a'],
      pendingPermissionRequests: [
        { toolUseId: 'tool-a', tool: 'Bash', riskClass: 'secret', detached: true },
      ],
    });
  const decided = {
    t: 'permission.decided',
    sessionId: 's1',
    toolUseId: 'tool-a',
    rev: 2,
    outcome: 'allowed',
  } as const;

  it('drops an answered card even while Home is not running', async () => {
    const model = new SessionListModel({
      client: clientFor(() => Promise.resolve([waiting()])),
    });
    await model.refresh();
    model.applyDomainEvent(decided);
    expect(model.state.sessions[0]?.pendingPermissionRequests).toEqual([]);
  });

  it('keeps the card gone when a read that started before the answer returns', async () => {
    // The read was already on its way when another device answered; its
    // response still lists the request and must not bring the card back.
    let release: (sessions: SessionSummary[]) => void = () => undefined;
    const listSessions = vi
      .fn<() => Promise<SessionSummary[]>>()
      .mockResolvedValueOnce([waiting()])
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValue([summary('s1')]);
    const model = new SessionListModel({ client: clientFor(listSessions) });
    await model.refresh();
    const stale = model.refresh();
    model.applyDomainEvent(decided);
    release([waiting()]);
    await stale;
    expect(model.state.sessions[0]?.pendingPermissionRequests).toEqual([]);
    // A read started after the answer is the server's word again.
    await model.refresh();
    expect(model.state.sessions[0]?.pendingPermissionRequests).toBeUndefined();
  });

  it('reads the list when a new request opens', async () => {
    vi.useFakeTimers();
    const listSessions = vi.fn(() => Promise.resolve([summary('s1')]));
    const model = new SessionListModel({ client: clientFor(listSessions), pollIntervalMs: 0 });
    model.start();
    await vi.advanceTimersByTimeAsync(0);
    model.applyDomainEvent({
      t: 'permission.requested',
      sessionId: 's1',
      toolUseId: 'tool-b',
      rev: 3,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(listSessions).toHaveBeenCalledTimes(2);
    model.stop();
  });
});
