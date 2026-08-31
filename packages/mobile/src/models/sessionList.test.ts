import { describe, expect, it, vi } from 'vitest';
import {
  VerityApiError,
  type VerityClient,
  type SessionStatus,
  type SessionSummary,
} from '../api.js';
import { SessionListModel, type SessionListState } from './sessionList.js';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

function session(id: string, status: SessionStatus, name: string | null = null): SessionSummary {
  return { sessionId: id, worktree: `/wt/${id}`, model: 'm', name, status, usage: ZERO_USAGE };
}

function makeClient(): {
  client: VerityClient;
  listSessions: ReturnType<typeof vi.fn<() => Promise<SessionSummary[]>>>;
  listProviderLimits: ReturnType<typeof vi.fn<() => Promise<SessionSummary['rateLimits']>>>;
  renameSession: ReturnType<
    typeof vi.fn<
      (id: string, name: string | null) => Promise<{ sessionId: string; name: string | null }>
    >
  >;
  deleteSession: ReturnType<
    typeof vi.fn<(id: string, opts?: { force?: boolean }) => Promise<{ sessionId: string }>>
  >;
} {
  const listSessions = vi.fn<() => Promise<SessionSummary[]>>();
  const listProviderLimits = vi.fn<() => Promise<SessionSummary['rateLimits']>>();
  listProviderLimits.mockResolvedValue([]);
  const renameSession =
    vi.fn<
      (id: string, name: string | null) => Promise<{ sessionId: string; name: string | null }>
    >();
  const deleteSession =
    vi.fn<(id: string, opts?: { force?: boolean }) => Promise<{ sessionId: string }>>();
  return {
    client: {
      listSessions,
      listProviderLimits,
      renameSession,
      deleteSession,
    } as unknown as VerityClient,
    listSessions,
    listProviderLimits,
    renameSession,
    deleteSession,
  };
}

describe('SessionListModel server attention', () => {
  it('reports nothing when the client cannot ask for the envelope', async () => {
    // An app talking to a server that predates the envelope: the model falls
    // back to the plain list and must not invent a banner out of its absence.
    const { client, listSessions } = makeClient();
    listSessions.mockResolvedValueOnce([session('a', 'running')]);
    const model = new SessionListModel({ client });

    await model.refresh();

    expect(model.state.serverAttention).toBeNull();
    expect(model.state.sessions).toHaveLength(1);
  });

  it('surfaces the server-level notice from the overview envelope', async () => {
    const { client, listSessions } = makeClient();
    const listSessionOverview = vi.fn(() =>
      Promise.resolve({
        sessions: [session('a', 'running')],
        attention: [{ code: 'secret_sealed', message: 'Server is sealed' }],
      }),
    );
    const model = new SessionListModel({
      client: { ...client, listSessionOverview } as unknown as typeof client,
    });

    await model.refresh();

    expect(listSessions).not.toHaveBeenCalled();
    expect(model.state.serverAttention).toEqual({
      code: 'secret_sealed',
      message: 'Server is sealed',
      count: 1,
    });
  });

  it('clears the notice as soon as the server stops reporting it', async () => {
    const { client } = makeClient();
    const listSessionOverview = vi
      .fn(() =>
        Promise.resolve({ sessions: [], attention: [] as { code: string; message: string }[] }),
      )
      .mockResolvedValueOnce({
        sessions: [],
        attention: [{ code: 'updater_unhealthy', message: 'Updater is not answering' }],
      });
    const model = new SessionListModel({
      client: { ...client, listSessionOverview } as unknown as typeof client,
    });

    await model.refresh();
    expect(model.state.serverAttention?.code).toBe('updater_unhealthy');

    await model.refresh();
    expect(model.state.serverAttention).toBeNull();
  });

  // Attention codes are a free string on the wire on purpose: the server decides
  // what is worth saying and the client renders the sentence it was given. This
  // pins that — a code this app has never heard of still reaches the screen, so
  // adding one server-side is not a two-sided change.
  it('renders a code it has no special handling for', async () => {
    const { client } = makeClient();
    const listSessionOverview = vi.fn(() =>
      Promise.resolve({
        sessions: [],
        attention: [
          {
            // Deliberately not a code this branch adds — one no version of the
            // server has ever sent. A code the app already knows would prove
            // nothing about the codes it does not.
            code: 'some_future_code',
            message: 'Something the server learned to say after this app shipped',
          },
        ],
      }),
    );
    const model = new SessionListModel({
      client: { ...client, listSessionOverview } as unknown as typeof client,
    });

    await model.refresh();

    expect(model.state.serverAttention).toEqual({
      code: 'some_future_code',
      message: 'Something the server learned to say after this app shipped',
      count: 1,
    });
  });
});

describe('SessionListModel.refresh', () => {
  it('loads sessions attention-first with a count, toggling loading', async () => {
    const { client, listSessions } = makeClient();
    listSessions.mockResolvedValueOnce([session('a', 'running'), session('b', 'crashed')]);
    const states: SessionListState[] = [];
    const model = new SessionListModel({ client, onChange: (s) => states.push(s) });

    await model.refresh();

    expect(model.state.sessions.map((s) => s.sessionId)).toEqual(['b', 'a']); // crashed first
    expect(model.state.attentionCount).toBe(1);
    expect(model.state.error).toBeUndefined();
    expect(model.state.providerLimitRows).toEqual([
      { providerLabel: 'Claude', fiveHour: null, weekly: null },
      { providerLabel: 'Codex', fiveHour: null, weekly: null },
    ]);
    expect(states[0]?.loading).toBe(true); // emitted loading first
    expect(model.state.loading).toBe(false);
    expect(states.at(-1)?.loading).toBe(false);
  });

  it('surfaces a VerityApiError message, a generic message otherwise, and clears on success', async () => {
    const { client, listSessions } = makeClient();
    const model = new SessionListModel({ client });

    listSessions.mockRejectedValueOnce(new VerityApiError(500, 'driver down'));
    await model.refresh();
    expect(model.state.error).toBe('driver down');
    expect(model.state.loading).toBe(false);

    listSessions.mockRejectedValueOnce(new Error('boom'));
    await model.refresh();
    expect(model.state.error).toBe('failed to load sessions');

    listSessions.mockResolvedValueOnce([session('a', 'idle')]);
    await model.refresh();
    expect(model.state.error).toBeUndefined();
  });

  it('discards a stale (superseded) refresh response', async () => {
    const { client, listSessions } = makeClient();
    let resolveSlow: (v: SessionSummary[]) => void = () => undefined;
    listSessions.mockReturnValueOnce(
      new Promise<SessionSummary[]>((resolve) => {
        resolveSlow = resolve;
      }),
    );
    listSessions.mockResolvedValueOnce([session('new', 'running')]);
    const model = new SessionListModel({ client });

    const slow = model.refresh(); // req 1 (slow)
    const fast = model.refresh(); // req 2 (fast) — supersedes req 1
    await fast;
    expect(model.state.sessions.map((s) => s.sessionId)).toEqual(['new']);

    resolveSlow([session('old', 'running')]); // req 1 resolves late
    await slow;
    expect(model.state.sessions.map((s) => s.sessionId)).toEqual(['new']); // stale discarded
    expect(model.state.loading).toBe(false);
  });

  it('discards a superseded refresh that REJECTS late (stale error ignored)', async () => {
    const { client, listSessions } = makeClient();
    let rejectSlow: (e: Error) => void = () => undefined;
    listSessions.mockReturnValueOnce(
      new Promise<SessionSummary[]>((_, reject) => {
        rejectSlow = reject;
      }),
    );
    listSessions.mockResolvedValueOnce([session('new', 'running')]);
    const model = new SessionListModel({ client });

    const slow = model.refresh(); // req 1
    const fast = model.refresh(); // req 2 supersedes
    await fast;
    expect(model.state.error).toBeUndefined();

    rejectSlow(new Error('late failure')); // req 1 rejects late — must be ignored
    await slow;
    expect(model.state.error).toBeUndefined(); // stale error discarded
    expect(model.state.sessions.map((s) => s.sessionId)).toEqual(['new']);
  });

  it('surfaces the latest active overview rate-limit notice until it expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { client, listSessions } = makeClient();
      listSessions.mockResolvedValueOnce([
        {
          ...session('expired', 'idle'),
          rateLimit: { status: 'rejected', resetsAt: 1_699_999_999, window: 'five_hour' },
        },
        {
          ...session('allowed', 'idle'),
          rateLimit: { status: 'allowed', resetsAt: 1_700_000_100, window: 'five_hour' },
        },
        {
          ...session('active', 'idle'),
          rateLimit: {
            status: 'rejected',
            resetsAt: 1_700_000_200,
            window: 'five_hour',
            providerLabel: 'Codex',
          },
        },
      ]);
      const model = new SessionListModel({ client });

      await model.refresh();

      expect(model.state.rateLimitNotice).toEqual({
        resetsAt: 1_700_000_200,
        window: 'five_hour',
        providerLabel: 'Codex',
        level: 'blocked',
      });
      vi.setSystemTime(new Date(1_700_000_201_000));
      expect(model.state.rateLimitNotice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a provider limit visible on the overview after that session switches model', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { client, listSessions } = makeClient();
      listSessions.mockResolvedValueOnce([
        {
          ...session('switched', 'idle'),
          model: 'codex/default',
          rateLimit: {
            status: 'rejected',
            resetsAt: 1_700_000_200,
            window: 'weekly',
            providerLabel: 'Claude',
          },
        },
      ]);
      const model = new SessionListModel({ client });

      await model.refresh();

      expect(model.state.rateLimitNotice).toEqual({
        resetsAt: 1_700_000_200,
        window: 'weekly',
        providerLabel: 'Claude',
        level: 'blocked',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('chooses the latest reset across multiple active provider limits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { client, listSessions } = makeClient();
      listSessions.mockResolvedValueOnce([
        {
          ...session('multi', 'idle'),
          rateLimits: [
            {
              status: 'rejected',
              resetsAt: 1_700_000_300,
              window: 'weekly',
              providerLabel: 'Claude',
            },
            {
              status: 'rejected',
              resetsAt: 1_700_000_200,
              window: 'five_hour',
              providerLabel: 'Codex',
            },
          ],
        },
      ]);
      const model = new SessionListModel({ client });

      await model.refresh();

      expect(model.state.rateLimitNotice).toEqual({
        resetsAt: 1_700_000_300,
        window: 'weekly',
        providerLabel: 'Claude',
        level: 'blocked',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds compact provider limit rows for overview meters', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { client, listSessions } = makeClient();
      listSessions.mockResolvedValueOnce([
        {
          ...session('meters', 'idle'),
          rateLimits: [
            {
              status: 'allowed',
              resetsAt: 1_700_000_100,
              window: 'five_hour',
              usedPercent: 42,
              providerLabel: 'Codex',
            },
            {
              status: 'rejected',
              resetsAt: 1_700_000_200,
              window: 'weekly',
              usedPercent: 100,
              providerLabel: 'Codex',
            },
          ],
        },
      ]);
      const model = new SessionListModel({ client });

      await model.refresh();

      expect(model.state.providerLimitRows).toEqual([
        {
          providerLabel: 'Claude',
          fiveHour: null,
          weekly: null,
        },
        {
          providerLabel: 'Codex',
          fiveHour: {
            status: 'allowed',
            resetsAt: 1_700_000_100,
            window: 'five_hour',
            usedPercent: 42,
          },
          weekly: {
            status: 'rejected',
            resetsAt: 1_700_000_200,
            window: 'weekly',
            usedPercent: 100,
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges account-global provider limits into overview meters', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { client, listSessions, listProviderLimits } = makeClient();
      listSessions.mockResolvedValueOnce([]);
      listProviderLimits.mockResolvedValueOnce([
        {
          status: 'allowed',
          resetsAt: 1_700_000_100,
          window: 'five_hour',
          usedPercent: 33,
          providerLabel: 'Claude',
        },
        {
          status: 'rejected',
          resetsAt: 1_700_000_200,
          window: 'weekly',
          usedPercent: 100,
          providerLabel: 'Claude',
        },
      ]);
      const model = new SessionListModel({ client });

      await model.refresh();

      expect(model.state.providerLimitRows).toEqual([
        {
          providerLabel: 'Claude',
          fiveHour: {
            status: 'allowed',
            resetsAt: 1_700_000_100,
            window: 'five_hour',
            usedPercent: 33,
          },
          weekly: {
            status: 'rejected',
            resetsAt: 1_700_000_200,
            window: 'weekly',
            usedPercent: 100,
          },
        },
        { providerLabel: 'Codex', fiveHour: null, weekly: null },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a model-scoped weekly limit replace the all-models meter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { client, listSessions, listProviderLimits } = makeClient();
      listProviderLimits.mockResolvedValueOnce([
        {
          status: 'allowed',
          resetsAt: 1_700_000_200,
          window: 'weekly',
          usedPercent: 90,
          providerLabel: 'Claude',
          observedAt: 1_700_000_000_000,
        },
      ]);
      listSessions.mockResolvedValueOnce([
        {
          ...session('model-limit', 'idle'),
          rateLimits: [
            {
              status: 'rejected',
              resetsAt: 1_700_000_200,
              window: 'weekly',
              usedPercent: 0,
              scope: 'sonnet',
              providerLabel: 'Claude',
              observedAt: 1_700_000_001_000,
            },
          ],
        },
      ]);
      const model = new SessionListModel({ client });

      await model.refresh();

      expect(model.state.providerLimitRows[0]?.weekly?.usedPercent).toBe(90);
      expect(model.state.rateLimitNotice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers the newest provider meter over a stale rejected state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T08:00:00Z'));
    try {
      const { client, listSessions, listProviderLimits } = makeClient();
      listProviderLimits.mockResolvedValueOnce([]);
      listSessions.mockResolvedValueOnce([
        {
          ...session('stale', 'idle'),
          rateLimits: [
            {
              status: 'rejected',
              resetsAt: 1_784_410_200,
              window: 'weekly',
              usedPercent: 0,
              providerLabel: 'Codex',
              observedAt: 1_783_900_000_000,
            },
          ],
        },
        {
          ...session('current', 'idle'),
          rateLimits: [
            {
              status: 'allowed',
              resetsAt: 1_784_380_896,
              window: 'weekly',
              usedPercent: 1,
              providerLabel: 'Codex',
              observedAt: 1_784_000_000_000,
            },
          ],
        },
      ]);
      const model = new SessionListModel({ client });

      await model.refresh();

      expect(model.state.providerLimitRows.find((row) => row.providerLabel === 'Codex')).toEqual({
        providerLabel: 'Codex',
        fiveHour: null,
        weekly: {
          status: 'allowed',
          resetsAt: 1_784_380_896,
          window: 'weekly',
          usedPercent: 1,
          observedAt: 1_784_000_000_000,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an undated persisted meter override a timestamped provider meter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { client, listSessions, listProviderLimits } = makeClient();
      listProviderLimits.mockResolvedValueOnce([
        {
          status: 'allowed',
          resetsAt: 1_700_000_200,
          window: 'weekly',
          usedPercent: 12,
          providerLabel: 'Claude',
          observedAt: 1_700_000_000_000,
        },
      ]);
      listSessions.mockResolvedValueOnce([
        {
          ...session('legacy', 'idle'),
          rateLimits: [
            {
              status: 'rejected',
              resetsAt: 1_700_000_300,
              window: 'weekly',
              usedPercent: 100,
              providerLabel: 'Claude',
            },
          ],
        },
      ]);
      const model = new SessionListModel({ client });
      await model.refresh();
      expect(model.state.providerLimitRows[0]?.weekly?.status).toBe('allowed');
      expect(model.state.providerLimitRows[0]?.weekly?.observedAt).toBe(1_700_000_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repairs Codex weekly meters persisted as five-hour by older servers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { client, listSessions } = makeClient();
      listSessions.mockResolvedValueOnce([
        {
          ...session('older', 'idle'),
          rateLimits: [
            {
              status: 'rejected',
              resetsAt: 1_700_500_000,
              window: 'five_hour',
              usedPercent: 8,
              providerLabel: 'Codex',
              observedAt: 1_699_999_000_000,
            },
          ],
        },
        {
          ...session('newer', 'idle'),
          rateLimits: [
            {
              status: 'rejected',
              resetsAt: 1_700_500_000,
              window: 'five_hour',
              usedPercent: 24,
              providerLabel: 'Codex',
              observedAt: 1_699_999_900_000,
            },
          ],
        },
      ]);
      const model = new SessionListModel({ client });

      await model.refresh();

      expect(model.state.providerLimitRows.find((row) => row.providerLabel === 'Codex')).toEqual({
        providerLabel: 'Codex',
        fiveHour: null,
        weekly: {
          status: 'rejected',
          resetsAt: 1_700_500_000,
          window: 'weekly',
          usedPercent: 24,
          observedAt: 1_699_999_900_000,
        },
      });
      expect(model.state.rateLimitNotice).toEqual({
        resetsAt: 1_700_500_000,
        window: 'weekly',
        providerLabel: 'Codex',
        level: 'blocked',
        usedPercent: 24,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionListModel.settlePermission', () => {
  it('removes only the answered permission and clears attention after the last one', async () => {
    const { client, listSessions } = makeClient();
    listSessions.mockResolvedValueOnce([
      {
        ...session('s1', 'awaiting_input'),
        pendingPermissions: ['tool-a', 'tool-b'],
        permissionAwaitingInput: true,
      },
    ]);
    const model = new SessionListModel({ client });
    await model.refresh();

    model.settlePermission('s1', 'tool-a');
    expect(model.state.sessions[0]).toMatchObject({
      status: 'awaiting_input',
      pendingPermissions: ['tool-b'],
    });

    model.settlePermission('s1', 'tool-b');
    expect(model.state.sessions[0]).toMatchObject({ status: 'running', pendingPermissions: [] });
  });

  it('preserves awaiting_input when the server did not attribute it to permission', async () => {
    const { client, listSessions } = makeClient();
    listSessions.mockResolvedValueOnce([
      { ...session('s1', 'awaiting_input'), pendingPermissions: ['tool-a'] },
    ]);
    const model = new SessionListModel({ client });
    await model.refresh();
    model.settlePermission('s1', 'tool-a');
    expect(model.state.sessions[0]?.status).toBe('awaiting_input');
  });
});

describe('SessionListModel.applyPullRequestStatus', () => {
  it('updates the overview projection immediately', async () => {
    const { client, listSessions } = makeClient();
    listSessions.mockResolvedValueOnce([
      {
        ...session('s1', 'idle'),
        pr: { phase: 'open', pipeline: 'success', mergeable: true },
      },
    ]);
    const model = new SessionListModel({ client });
    await model.refresh();

    model.applyPullRequestStatus('s1', {
      phase: 'merged',
      pipeline: 'success',
      mergeable: false,
    });

    expect(model.state.sessions[0]?.pr).toEqual({
      phase: 'merged',
      pipeline: 'success',
      mergeable: false,
    });
  });
});

describe('SessionListModel.applySessionStatus', () => {
  it('removes a stale needs-input status immediately after an accepted action', async () => {
    const { client, listSessions } = makeClient();
    listSessions.mockResolvedValueOnce([session('s1', 'awaiting_input')]);
    const model = new SessionListModel({ client });
    await model.refresh();

    model.applySessionStatus('s1', 'running');

    expect(model.state.sessions[0]?.status).toBe('running');
  });

  it('preserves initial loading and overlays the action when the session arrives', async () => {
    const { client, listSessions } = makeClient();
    let resolve!: (sessions: SessionSummary[]) => void;
    listSessions.mockImplementation(
      () => new Promise<SessionSummary[]>((done) => (resolve = done)),
    );
    const model = new SessionListModel({ client });

    const refresh = model.refresh();
    await Promise.resolve();
    expect(model.state.loading).toBe(true);

    model.applySessionStatus('s1', 'running');
    expect(model.state.loading).toBe(true);
    resolve([session('s1', 'awaiting_input')]);
    await refresh;

    expect(model.state.loading).toBe(false);
    expect(model.state.sessions[0]?.status).toBe('running');
  });

  it('accepts authoritative status from a refresh started after the action', async () => {
    const { client, listSessions } = makeClient();
    listSessions.mockResolvedValueOnce([session('s1', 'idle')]);
    const model = new SessionListModel({ client });

    model.applySessionStatus('s1', 'running');
    await model.refresh();

    expect(model.state.sessions[0]?.status).toBe('idle');
  });
});

describe('SessionListModel.rename', () => {
  it('optimistically updates the name, then reconciles with the server value', async () => {
    const { client, listSessions, renameSession } = makeClient();
    listSessions.mockResolvedValue([session('a', 'idle')]);
    renameSession.mockResolvedValueOnce({ sessionId: 'a', name: 'Fix login' });
    const states: SessionListState[] = [];
    const model = new SessionListModel({ client, onChange: (s) => states.push(s) });
    await model.refresh();

    states.length = 0;
    await model.rename('a', '  Fix login  ');

    // First emit carries the optimistic (raw) name; the last carries the
    // server-canonical (trimmed) one.
    expect(states[0]?.sessions[0]?.name).toBe('  Fix login  ');
    expect(model.state.sessions[0]?.name).toBe('Fix login');
    expect(renameSession).toHaveBeenCalledWith('a', '  Fix login  ');
    expect(model.state.error).toBeUndefined();
  });

  it('clears a name when renamed to null', async () => {
    const { client, listSessions, renameSession } = makeClient();
    listSessions.mockResolvedValue([session('a', 'idle', 'old')]);
    renameSession.mockResolvedValueOnce({ sessionId: 'a', name: null });
    const model = new SessionListModel({ client });
    await model.refresh();

    await model.rename('a', null);
    expect(model.state.sessions[0]?.name).toBeNull();
  });

  it('reverts the optimistic name and surfaces the error when the rename fails', async () => {
    const { client, listSessions, renameSession } = makeClient();
    listSessions.mockResolvedValue([session('a', 'idle', 'original')]);
    renameSession.mockRejectedValueOnce(new VerityApiError(404, 'session a not found'));
    const states: SessionListState[] = [];
    const model = new SessionListModel({ client, onChange: (s) => states.push(s) });
    await model.refresh();

    states.length = 0;
    await model.rename('a', 'doomed');

    // The optimistic name showed mid-flight, then reverted to the original.
    expect(states[0]?.sessions[0]?.name).toBe('doomed');
    expect(model.state.sessions[0]?.name).toBe('original');
    expect(model.state.error).toBe('session a not found');
  });
});

describe('SessionListModel.delete', () => {
  it('optimistically removes the session, then confirms with the server', async () => {
    const { client, listSessions, deleteSession } = makeClient();
    listSessions.mockResolvedValue([session('a', 'idle'), session('b', 'idle')]);
    deleteSession.mockResolvedValueOnce({ sessionId: 'a' });
    const states: SessionListState[] = [];
    const model = new SessionListModel({ client, onChange: (s) => states.push(s) });
    await model.refresh();

    states.length = 0;
    await model.delete('a');

    // Gone immediately (optimistic) and still gone after the server confirms.
    expect(states[0]?.sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(model.state.sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(deleteSession).toHaveBeenCalledWith('a');
    expect(model.state.error).toBeUndefined();
  });

  it('re-inserts the session and surfaces the error when the delete fails', async () => {
    const { client, listSessions, deleteSession } = makeClient();
    listSessions.mockResolvedValue([session('a', 'idle'), session('b', 'idle')]);
    deleteSession.mockRejectedValueOnce(new VerityApiError(409, 'session a is busy'));
    const states: SessionListState[] = [];
    const model = new SessionListModel({ client, onChange: (s) => states.push(s) });
    await model.refresh();

    states.length = 0;
    await expect(model.delete('a')).rejects.toMatchObject({ status: 409 });

    // Removed mid-flight, then restored on failure.
    expect(states[0]?.sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(model.state.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
    expect(model.state.error).toBe('session a is busy');
  });

  it('restores the latest polled session state when deletion fails', async () => {
    const { client, listSessions, deleteSession } = makeClient();
    listSessions.mockResolvedValueOnce([session('a', 'idle', 'original')]);
    listSessions.mockResolvedValueOnce([session('a', 'running', 'updated')]);
    let rejectDelete!: (error: Error) => void;
    deleteSession.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectDelete = reject;
        }),
    );
    const model = new SessionListModel({ client });
    await model.refresh();

    const deleting = model.delete('a');
    await model.refresh();
    rejectDelete(new VerityApiError(409, 'session a is busy'));
    await expect(deleting).rejects.toMatchObject({ status: 409 });

    expect(model.state.sessions[0]).toMatchObject({
      sessionId: 'a',
      status: 'running',
      name: 'updated',
    });
  });

  it('passes force through when deleting after confirmation', async () => {
    const { client, listSessions, deleteSession } = makeClient();
    listSessions.mockResolvedValue([session('a', 'running')]);
    deleteSession.mockResolvedValueOnce({ sessionId: 'a' });
    const model = new SessionListModel({ client });
    await model.refresh();

    await model.delete('a', { force: true });

    expect(deleteSession).toHaveBeenCalledWith('a', { force: true });
    expect(model.state.sessions).toEqual([]);
  });

  it('keeps a session hidden when a poll returns while deletion is in flight', async () => {
    const { client, listSessions, deleteSession } = makeClient();
    listSessions.mockResolvedValue([session('a', 'idle'), session('b', 'idle')]);
    let confirmDelete!: () => void;
    deleteSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirmDelete = () => resolve({ sessionId: 'a' });
        }),
    );
    const model = new SessionListModel({ client });
    await model.refresh();

    const deleting = model.delete('a');
    expect(model.state.sessions.map((s) => s.sessionId)).toEqual(['b']);

    // The server has not completed deletion yet, so its poll response is stale.
    await model.refresh();
    expect(model.state.sessions.map((s) => s.sessionId)).toEqual(['b']);

    confirmDelete();
    await deleting;
    expect(model.state.sessions.map((s) => s.sessionId)).toEqual(['b']);
  });

  it('keeps a session hidden when a stale poll resolves after deletion succeeds', async () => {
    const { client, listSessions, deleteSession } = makeClient();
    listSessions.mockResolvedValueOnce([session('a', 'idle'), session('b', 'idle')]);
    let resolveStalePoll!: (sessions: SessionSummary[]) => void;
    listSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStalePoll = resolve;
        }),
    );
    deleteSession.mockResolvedValueOnce({ sessionId: 'a' });
    const model = new SessionListModel({ client });
    await model.refresh();

    const stalePoll = model.refresh();
    await model.delete('a');
    resolveStalePoll([session('a', 'idle'), session('b', 'idle')]);
    await stalePoll;

    expect(model.state.sessions.map((s) => s.sessionId)).toEqual(['b']);
  });

  it('ignores a late failure when an overlapping delete already succeeded', async () => {
    const { client, listSessions, deleteSession } = makeClient();
    listSessions.mockResolvedValue([session('a', 'idle')]);
    let confirmFirst!: () => void;
    let rejectSecond!: (error: Error) => void;
    deleteSession
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            confirmFirst = () => resolve({ sessionId: 'a' });
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSecond = reject;
          }),
      );
    const model = new SessionListModel({ client });
    await model.refresh();

    const first = model.delete('a');
    const second = model.delete('a');
    confirmFirst();
    await first;
    rejectSecond(new VerityApiError(404, 'session a not found'));
    await expect(second).resolves.toBeUndefined();

    expect(model.state.sessions).toEqual([]);
    expect(model.state.error).toBeUndefined();
  });
});

describe('SessionListModel polling', () => {
  it('does an initial load, polls via the injected scheduler, and stops on stop()', async () => {
    const { client, listSessions } = makeClient();
    listSessions.mockResolvedValue([]);
    let poll: () => void = () => undefined;
    let tick: () => void = () => undefined;
    const cancelled: boolean[] = [];
    const model = new SessionListModel({
      client,
      schedule: (p, intervalMs) => {
        if (intervalMs === 2000) poll = p;
        if (intervalMs === 30_000) tick = p;
        const idx = cancelled.length;
        cancelled.push(false);
        return () => {
          cancelled[idx] = true;
        };
      },
    });

    model.start();
    expect(listSessions).toHaveBeenCalledTimes(1); // initial load (called synchronously)
    await new Promise<void>((done) => setTimeout(done, 0));
    poll(); // a scheduled poll fires
    expect(listSessions).toHaveBeenCalledTimes(2);
    tick(); // time-only recompute, no network poll
    expect(listSessions).toHaveBeenCalledTimes(2);

    model.stop();
    expect(cancelled).toEqual([true, true]);
    await Promise.resolve(); // let the in-flight refreshes settle
  });

  it('start() is idempotent — a second start cancels the first poll (no timer leak)', () => {
    const { client, listSessions } = makeClient();
    listSessions.mockResolvedValue([]);
    const cancelled: boolean[] = [];
    let n = 0;
    const model = new SessionListModel({
      client,
      schedule: () => {
        const idx = n++;
        return () => {
          cancelled[idx] = true;
        };
      },
    });
    model.start(); // poll #0
    model.start(); // cancels poll #0 + tick #1, schedules poll #2 + tick #3
    expect(cancelled[0]).toBe(true);
    expect(cancelled[1]).toBe(true);
    model.stop();
    expect(cancelled[2]).toBe(true);
    expect(cancelled[3]).toBe(true);
  });

  it('uses a real setInterval by default and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const { client, listSessions } = makeClient();
      listSessions.mockResolvedValue([]);
      const model = new SessionListModel({ client, pollIntervalMs: 1000 });
      model.start();
      expect(listSessions).toHaveBeenCalledTimes(1); // initial load
      await vi.advanceTimersByTimeAsync(0); // settle the initial resolved request
      vi.advanceTimersByTime(1000);
      expect(listSessions).toHaveBeenCalledTimes(2); // polled
      model.stop();
      vi.advanceTimersByTime(3000);
      expect(listSessions).toHaveBeenCalledTimes(2); // no polls after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces interval ticks while a slow poll is still in flight', async () => {
    const { client, listSessions } = makeClient();
    let resolve!: (sessions: SessionSummary[]) => void;
    listSessions.mockImplementation(
      () =>
        new Promise<SessionSummary[]>((done) => {
          resolve = done;
        }),
    );
    let poll: () => void = () => undefined;
    const model = new SessionListModel({
      client,
      schedule: (scheduled, intervalMs) => {
        if (intervalMs === 2000) poll = scheduled;
        return () => undefined;
      },
    });

    model.start();
    expect(listSessions).toHaveBeenCalledTimes(1);
    poll();
    poll();
    expect(listSessions).toHaveBeenCalledTimes(1);

    resolve([]);
    await new Promise<void>((done) => setTimeout(done, 0));
    poll();
    expect(listSessions).toHaveBeenCalledTimes(2);
    model.stop();
  });

  it('re-emits on the time tick so expired provider windows disappear without a network poll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { client, listSessions, listProviderLimits } = makeClient();
      listSessions.mockResolvedValue([]);
      listProviderLimits.mockResolvedValue([
        {
          status: 'allowed',
          resetsAt: 1_700_000_001,
          window: 'five_hour',
          usedPercent: 12,
          providerLabel: 'Claude',
        },
      ]);
      const states: SessionListState[] = [];
      const model = new SessionListModel({
        client,
        timeTickMs: 1000,
        onChange: (state) => states.push(state),
      });

      model.start();
      await vi.waitFor(() =>
        expect(states.at(-1)?.providerLimitRows[0]?.fiveHour).toMatchObject({
          usedPercent: 12,
        }),
      );

      vi.advanceTimersByTime(1000);

      expect(states.at(-1)?.providerLimitRows[0]?.fiveHour).toBeNull();
      model.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
