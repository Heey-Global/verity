import { beginSessionSwitch } from '../sessionSwitchTiming.js';
import type { AgentEvent } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';
import { VerityApiError, type VerityClient } from '../api.js';
import { SessionReducer } from '../reducer.js';
import { FakeTransport, type FakeSubscription } from '../live/testing.js';
import { DEFAULT_ACTIVITY_POLL_MS, SessionModel, type SessionModelState } from './session.js';

function recordingConnect(): { connect: FakeTransport; sockets: FakeSubscription[] } {
  const connect = new FakeTransport();
  return { connect, sockets: connect.sockets };
}

function stubClient(): VerityClient {
  // getSession backs the resumable probe on start(); default to a live session.
  // getHistory backs the tail-open probe; default to "short session" (no older
  // events) → the stream opens from seq 0 (full replay), as before.
  return {
    sendTurn: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ resumable: true }),
    getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
    getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
  } as unknown as VerityClient;
}

/** Flush microtasks + a macrotask so the async tail-open (getHistory → stream
 * connect) has run and the socket exists. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function agentTexts(state: SessionModelState): string[] {
  return state.session.messages
    .filter((m) => m.kind === 'agent-text')
    .map((m) => (m.kind === 'agent-text' ? m.text : ''));
}

function metadataHistoryEvent(seq: number): { seq: number; event: AgentEvent } {
  return {
    seq,
    event: {
      t: 'rate_limit',
      status: 'rejected',
      resetsAt: 1_700_000_000,
      window: 'five_hour',
      providerLabel: 'Claude',
    },
  };
}

describe('SessionModel — stream', () => {
  it('refreshes the name and project after session settings change', async () => {
    const client = stubClient();
    vi.spyOn(client, 'getSession').mockResolvedValue({
      name: 'Renamed',
      projectId: 'moved-project',
      resumable: true,
    } as Awaited<ReturnType<VerityClient['getSession']>>);
    const model = new SessionModel({ client, sessionId: 's1', transport: new FakeTransport() });
    model.refreshMetadata();
    await flush();
    expect(model.state.name).toBe('Renamed');
    expect(model.state.projectId).toBe('moved-project');
    model.stop();
  });

  it('publishes REST history before the live replay has caught up', async () => {
    const { connect, sockets } = recordingConnect();
    let resolveHistory!: (page: Awaited<ReturnType<VerityClient['getHistory']>>) => void;
    const client = stubClient();
    const getHistory = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    client.getHistory = getHistory;
    const getActivity = vi.fn().mockResolvedValue({ busy: false, queued: [] });
    client.getActivity = getActivity;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    try {
      model.start();
      expect(getHistory).toHaveBeenCalledTimes(1);
      expect(getActivity).not.toHaveBeenCalled();
      resolveHistory({
        events: [{ seq: 100, event: { t: 'text', delta: 'tail' } }],
        hasMore: true,
      });
      await flush();
      // A slow live replay must not hide a complete REST transcript.
      expect(model.state.loaded).toBe(true);
      expect(agentTexts(model.state)).toEqual(['tail']);
      expect(model.state.hasOlder).toBe(true);
      expect(getActivity).toHaveBeenCalledTimes(1);
      expect(sockets[0]?.sinceSeq).toBe(100);
      sockets[0]?.emitEvent(101, { t: 'text', delta: ' replay' });
      sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 101 }));
      expect(agentTexts(model.state)).toEqual(['tail replay']);
    } finally {
      model.stop();
    }
  });

  it.each(['resolve', 'reject'] as const)(
    'opens on resume when the initial history probe settles in background (%s)',
    async (outcome) => {
      const { connect, sockets } = recordingConnect();
      let resolveHistory!: (page: Awaited<ReturnType<VerityClient['getHistory']>>) => void;
      let rejectHistory!: (error: Error) => void;
      const history = new Promise<Awaited<ReturnType<VerityClient['getHistory']>>>(
        (resolve, reject) => {
          resolveHistory = resolve;
          rejectHistory = reject;
        },
      );
      const client = stubClient();
      client.getHistory = vi.fn().mockReturnValue(history);
      const model = new SessionModel({ client, sessionId: 's1', transport: connect });
      try {
        model.start();
        model.pause();
        if (outcome === 'resolve') {
          resolveHistory({
            events: [{ seq: 100, event: { t: 'text', delta: 'tail' } }],
            hasMore: true,
          });
        } else {
          rejectHistory(new Error('background request failed'));
        }
        await flush();
        expect(sockets).toHaveLength(0);
        expect(model.state.loaded).toBe(outcome === 'resolve');

        // A completed probe must not strand the unstarted stream behind the loading screen.
        model.resume();
        await flush();
        expect(sockets).toHaveLength(1);
        expect(sockets[0]?.sinceSeq).toBe(outcome === 'resolve' ? 100 : 0);
        if (outcome === 'reject') sockets[0]?.emitEvent(100, { t: 'text', delta: 'loaded' });
        sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 100 }));
        expect(model.state.loaded).toBe(true);
        expect(agentTexts(model.state)).toEqual([outcome === 'resolve' ? 'tail' : 'loaded']);
      } finally {
        model.stop();
      }
    },
  );

  it('streams events into the session state and notifies, at the right URL', async () => {
    const { connect, sockets } = recordingConnect();
    const updates: number[] = [];
    const model = new SessionModel({
      client: stubClient(),
      sessionId: 's1',
      transport: connect,
      onChange: (s) => updates.push(s.session.messages.length),
    });
    model.start();
    await flush();
    expect(sockets[0]?.sinceSeq).toBe(0);
    sockets[0]?.emitEvent(1, { t: 'text', delta: 'hi' });
    // Backlog is batched: the screen only updates at the caught_up watermark.
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(agentTexts(model.state)).toEqual(['hi']);
    expect(updates.at(-1)).toBe(1);
  });

  it('opens a long session from its tail (resumes the WS past the older backlog)', async () => {
    const { connect, sockets } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      // Tail page's oldest event is seq 100, and older events exist (hasMore).
      getHistory: vi.fn().mockResolvedValue({
        events: [{ seq: 100, event: { t: 'text', delta: 'x' } }],
        hasMore: true,
      }),
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    // REST seeds the tail; the socket only replays events persisted afterwards.
    expect(sockets[0]?.sinceSeq).toBe(100);
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 100 }));
    expect(agentTexts(model.state)).toEqual(['x']);
  });

  it('opens far enough back when the latest tail page has no renderable messages', async () => {
    const { connect, sockets } = recordingConnect();
    const getHistory = vi
      .fn()
      .mockResolvedValueOnce({
        events: [
          {
            seq: 100,
            event: {
              t: 'task',
              id: 'task-1',
              phase: 'progress',
              description: 'background verification',
            },
          },
        ],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [{ seq: 50, event: { t: 'text', delta: 'visible tail' } }],
        hasMore: true,
      });
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory,
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });

    model.start();
    await flush();

    expect(getHistory).toHaveBeenNthCalledWith(2, 's1', { beforeSeq: 100, limit: 150 });
    expect(sockets[0]?.sinceSeq).toBe(100);
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 100 }));
    expect(agentTexts(model.state)).toEqual(['visible tail']);
    expect(model.state.hasOlder).toBe(true);
  });

  it('scans past a long metadata-only tail without replaying it over the socket', async () => {
    const { connect, sockets } = recordingConnect();
    let pages = 0;
    const getHistory = vi.fn().mockImplementation(() => {
      pages += 1;
      const seq = 1_001 - pages * 100;
      return Promise.resolve({
        events:
          pages === 6
            ? [{ seq, event: { t: 'text', delta: 'recovered' } }]
            : [metadataHistoryEvent(seq)],
        hasMore: true,
      });
    });
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory,
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });

    model.start();
    await flush();

    // Five pages was the former cutoff. Keep walking REST history until the snapshot
    // can render, then connect after its newest event instead of bursting the entire
    // session through the WebSocket.
    expect(getHistory).toHaveBeenCalledTimes(6);
    expect(sockets[0]?.sinceSeq).toBe(901);
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 901 }));
    expect(agentTexts(model.state)).toEqual(['recovered']);
    expect(model.state.hasOlder).toBe(true);
  });

  it('uses the detail rate-limit state when the tail replay skipped the event', async () => {
    const { connect, sockets } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({
        model: 'codex/default',
        resumable: true,
        rateLimit: {
          status: 'rejected',
          resetsAt: 1_700_000_000,
          window: 'five_hour',
          providerLabel: 'Codex',
        },
      }),
      getHistory: vi.fn().mockResolvedValue({
        events: [{ seq: 100, event: { t: 'text', delta: 'tail A' } }],
        hasMore: true,
      }),
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });

    model.start();
    await flush();
    sockets[0]?.emitEvent(100, { t: 'text', delta: 'tail A' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 100 }));

    await vi.waitFor(() => {
      expect(model.state.session.rateLimit).toEqual({
        status: 'rejected',
        resetsAt: 1_700_000_000,
        window: 'five_hour',
        providerLabel: 'Codex',
      });
    });
  });

  it('ignores a replayed stream rate-limit for a provider that no longer matches the model', async () => {
    const { connect, sockets } = recordingConnect();
    const client = {
      ...stubClient(),
      getSession: vi.fn().mockResolvedValue({ resumable: true, model: 'codex/default' }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });

    model.start();
    await flush();
    await vi.waitFor(() => {
      expect(model.state.model).toBe('codex/default');
    });
    sockets[0]?.emitEvent(1, {
      t: 'rate_limit',
      status: 'rejected',
      resetsAt: 1_700_000_000,
      window: 'five_hour',
      providerLabel: 'Claude',
    });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));

    expect(model.state.session.rateLimit).toBeUndefined();
  });

  it('latches loaded only once the backlog drains (caught_up), gating the empty-state', async () => {
    const { connect, sockets } = recordingConnect();
    const model = new SessionModel({
      client: stubClient(),
      sessionId: 's1',
      transport: connect,
    });
    model.start();
    await flush();
    expect(model.state.locallyCreated).toBe(false);
    expect(model.state.loaded).toBe(false); // still connecting / loading backlog
    sockets[0]?.emitEvent(1, { t: 'text', delta: 'hi' });
    expect(model.state.loaded).toBe(false); // backlog event applied but batched — not loaded yet
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(model.state.loaded).toBe(true); // first snapshot at caught_up → loaded
  });

  it('exposes reconnect lifecycle in model state', async () => {
    const { connect, sockets } = recordingConnect();
    const model = new SessionModel({ client: stubClient(), sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.connectionState).toBe('connecting');
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
    expect(model.state.connectionState).toBe('connected');
    sockets[0]?.emitClose();
    expect(model.state.connectionState).toBe('reconnecting');
    connect.reconnect();
    sockets[1]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
    expect(model.state.connectionState).toBe('connected');
    model.stop();
    expect(model.state.connectionState).toBe('stopped');
  });

  it('reports a session the server will not stream and stops', async () => {
    const { connect, sockets } = recordingConnect();
    const model = new SessionModel({ client: stubClient(), sessionId: 's1', transport: connect });
    model.start();
    await flush();
    sockets[0]?.emitRaw(JSON.stringify({ k: 'ended', reason: 'forbidden' }));
    expect(model.state.streamError).toBe('You no longer have access to this session.');
    expect(model.state.connectionState).toBe('stopped');
  });

  it('subscribes as viewing only while the screen says so', async () => {
    const { connect, sockets } = recordingConnect();
    const model = new SessionModel({ client: stubClient(), sessionId: 's1', transport: connect });
    model.setView(true);
    model.start();
    await flush();
    expect(sockets[0]?.view).toBe(true);
    model.setView(false);
    expect(sockets[0]?.view).toBe(false);
    model.stop();
  });

  it('stops the stream on stop()', async () => {
    const { connect, sockets } = recordingConnect();
    const model = new SessionModel({
      client: stubClient(),
      sessionId: 's1',
      transport: connect,
    });
    model.start();
    await flush();
    model.stop();
    expect(sockets[0]?.closed).toBe(true);
  });

  it('does not open the stream when stop wins a slow tail-history probe', async () => {
    let resolveHistory!: (value: { events: []; hasMore: false }) => void;
    const client = stubClient();
    vi.spyOn(client, 'getHistory').mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const { connect, sockets } = recordingConnect();
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    model.stop();
    resolveHistory({ events: [], hasMore: false });
    await flush();
    expect(sockets).toHaveLength(0);
  });
});

describe('SessionModel — loadOlderUntil (bookmark jump)', () => {
  it('fetches the exact span down to the target seq in one request and prepends it', async () => {
    const { connect, sockets } = recordingConnect();
    // Bind the mock to a local so assertions don't reference an unbound method (lint).
    const getHistory = vi.fn().mockImplementation((_id: string, opts?: { beforeSeq?: number }) =>
      // Tail-open probe (no beforeSeq): oldest loaded is seq 100, older exists.
      // The targeted jump (beforeSeq set): return the older event at the target seq.
      opts?.beforeSeq === undefined
        ? Promise.resolve({
            events: [{ seq: 100, event: { t: 'text', delta: 'tail' } }],
            hasMore: true,
          })
        : Promise.resolve({
            events: [{ seq: 42, event: { t: 'text', delta: 'old' } }],
            hasMore: false,
          }),
    );
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory,
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    // Stream the tail so the reducer has a loaded head (oldestSeq = 100).
    sockets[0]?.emitEvent(100, { t: 'text', delta: 'tail' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 100 }));

    await model.loadOlderUntil(42);

    // One fetch sized to the whole span (100 − 42), not a fixed 150 page.
    expect(getHistory).toHaveBeenCalledWith('s1', { beforeSeq: 100, limit: 58, timing: undefined });
    // The older event is prepended AHEAD of the tail — consecutive agent-text deltas
    // coalesce, so the merged 'old'+'tail' (not 'tail'+'old') confirms the order.
    expect(agentTexts(model.state)).toEqual(['oldtail']);
    expect(model.state.hasOlder).toBe(false); // page reported no more → affordance clears
  });

  it('is a no-op when the target is already within the loaded window', async () => {
    const { connect, sockets } = recordingConnect();
    // Bind the mock to a local so assertions don't reference an unbound method (lint).
    const getHistory = vi.fn().mockResolvedValue({
      events: [{ seq: 100, event: { t: 'text', delta: 'tail' } }],
      hasMore: true,
    });
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory,
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    sockets[0]?.emitEvent(100, { t: 'text', delta: 'tail' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 100 }));
    getHistory.mockClear();

    await model.loadOlderUntil(150); // target newer than the oldest loaded → nothing to do

    expect(getHistory).not.toHaveBeenCalled();
  });
});

describe('SessionModel — busy seeding', () => {
  it('seeds the working indicator from the detail status before the first poll lands', async () => {
    const { connect } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true, status: 'running' }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      // Never resolves within the test → the seed must come from the detail probe.
      getActivity: vi.fn().mockReturnValue(new Promise(() => {})),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    // No activity poll has resolved, yet the Stop button / activity line are lit
    // because the detail's server-derived status says the session is running.
    expect(model.state.busy).toBe(true);
  });

  it('lets a resolved activity poll win over a slow detail probe (no clobber)', async () => {
    const { connect } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      // The detail probe is slow and says `running`; it must NOT revert a fresher
      // poll that already reported the turn finished.
      getSession: vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ resumable: true, status: 'running' }), 10),
            ),
        ),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush(); // activity poll resolves first → busy=false, _activityLoaded=true
    expect(model.state.busy).toBe(false);
    await new Promise((r) => setTimeout(r, 20)); // slow detail probe now lands
    expect(model.state.busy).toBe(false); // guarded → the poll's value stands
  });

  it('seeds busy from detail.busy for an in-flight turn parked on a permission prompt', async () => {
    const { connect } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      // Parked on a permission prompt: status is `awaiting_input` (not running), but
      // the turn is in flight so `busy` is true. The seed must mirror `/activity`
      // (in-flight OR running) and light the indicator.
      getSession: vi
        .fn()
        .mockResolvedValue({ resumable: true, status: 'awaiting_input', busy: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockReturnValue(new Promise(() => {})),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.busy).toBe(true);
  });
});

describe('SessionModel — working reconciliation', () => {
  it('does not restart pulsing when a permission arrives during an older animation poll', async () => {
    const { connect, sockets } = recordingConnect();
    const client = stubClient();
    let resolve!: (value: { busy: boolean; activityAnimating: boolean; queued: [] }) => void;
    client.getActivity = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    try {
      model.start();
      await flush();
      sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
      sockets[0]?.emitEvent(1, { t: 'prompt', text: 'go' });
      sockets[0]?.emitEvent(2, {
        t: 'permission',
        id: 'p',
        tool: 'Bash',
        input: {},
        riskClass: 'ask',
      });
      resolve({ busy: true, activityAnimating: true, queued: [] });
      await flush();
      expect(model.state.working).toBe(true);
      expect(model.state.activityAnimating).toBe(false);
    } finally {
      model.stop();
    }
  });

  it('seeds animation from authoritative activity when the history tail omits waiting status', async () => {
    const { connect } = recordingConnect();
    const client = stubClient();
    client.getActivity = vi
      .fn()
      .mockResolvedValue({ busy: true, activityAnimating: false, queued: [] });
    const emitted: boolean[] = [];
    const model = new SessionModel({
      client,
      sessionId: 's1',
      transport: connect,
      onChange: (state) => emitted.push(state.activityAnimating),
    });
    try {
      model.start();
      await flush();
      expect(model.state.session.status).toBeUndefined();
      expect(model.state.working).toBe(true);
      expect(model.state.activityAnimating).toBe(false);
      emitted.length = 0;
      client.getActivity = vi
        .fn()
        .mockResolvedValue({ busy: true, activityAnimating: true, queued: [] });
      model.refreshActivity();
      await flush();
      expect(model.state.activityAnimating).toBe(true);
      expect(emitted).toContain(true);
    } finally {
      model.stop();
    }
  });

  it.each([true, false])(
    'new lifecycle events win over a stale animation poll (%s)',
    async (animating) => {
      const { connect, sockets } = recordingConnect();
      const client = stubClient();
      let resolve!: (value: { busy: boolean; activityAnimating: boolean; queued: [] }) => void;
      client.getActivity = vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      );
      const model = new SessionModel({ client, sessionId: 's1', transport: connect });
      try {
        model.start();
        await flush();
        sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
        sockets[0]?.emitEvent(1, { t: 'prompt', text: 'go' });
        if (animating) sockets[0]?.emitEvent(2, { t: 'status', state: 'completed' });
        resolve({ busy: animating, activityAnimating: animating, queued: [] });
        await flush();
        expect(model.state.activityAnimating).toBe(!animating);
        expect(model.state.working).toBe(!animating);
      } finally {
        model.stop();
      }
    },
  );

  it('stops pulsing while awaiting input, retains Stop, and resumes on an answer', async () => {
    const { connect, sockets } = recordingConnect();
    const client = stubClient();
    client.getActivity = vi.fn().mockResolvedValue({ busy: true, queued: [] });
    client.decidePermission = vi.fn().mockResolvedValue({});
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    try {
      model.start();
      await flush();
      sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
      sockets[0]?.emitEvent(1, { t: 'prompt', text: 'go' });
      sockets[0]?.emitEvent(2, { t: 'status', state: 'awaiting_input' });
      expect(model.state.working).toBe(true);
      expect(model.state.activityAnimating).toBe(false);
      sockets[0]?.emitEvent(3, { t: 'prompt', text: 'yes' });
      expect(model.state.working).toBe(true);
      expect(model.state.activityAnimating).toBe(true);
      sockets[0]?.emitEvent(4, {
        t: 'permission',
        id: 'p',
        tool: 'Bash',
        input: {},
        riskClass: 'ask',
      });
      expect(model.state.activityAnimating).toBe(false);
      sockets[0]?.emitEvent(5, { t: 'task', id: 'bg', phase: 'started' });
      expect(model.state.activityAnimating).toBe(true);
      sockets[0]?.emitEvent(6, { t: 'task', id: 'bg', phase: 'ended', status: 'completed' });
      expect(model.state.activityAnimating).toBe(false);
      await model.decidePermission('p', { behavior: 'allow' });
      expect(model.state.activityAnimating).toBe(true);
      sockets[0]?.emitEvent(7, { t: 'status', state: 'awaiting_dependency' });
      expect(model.state.working).toBe(true);
      expect(model.state.activityAnimating).toBe(false);
      sockets[0]?.emitEvent(8, { t: 'task', id: 'dependency-bg', phase: 'started' });
      expect(model.state.activityAnimating).toBe(true);
    } finally {
      model.stop();
    }
  });

  it('clears polled busy immediately at a streamed terminal boundary', async () => {
    const { connect, sockets } = recordingConnect();
    const client = stubClient();
    client.getActivity = vi.fn().mockResolvedValue({ busy: true, queued: [] });
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    try {
      model.start();
      await flush();
      sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
      sockets[0]?.emitEvent(1, { t: 'prompt', text: 'go' });
      expect(model.state.busy).toBe(true);
      sockets[0]?.emitEvent(2, { t: 'status', state: 'completed' });
      expect(model.state.busy).toBe(false);
      expect(model.state.working).toBe(false);
    } finally {
      model.stop();
    }
  });

  it.each<AgentEvent>([
    { t: 'status', state: 'completed' },
    { t: 'status', state: 'crashed' },
    { t: 'interrupted' },
  ])('keeps a streamed turn-end after an older busy poll resolves (%j)', async (terminal) => {
    const { connect, sockets } = recordingConnect();
    let resolveActivity!: (value: { busy: boolean; queued: [] }) => void;
    const client = stubClient();
    client.getActivity = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveActivity = resolve;
      }),
    );
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    try {
      model.start();
      await flush();
      sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
      sockets[0]?.emitEvent(1, { t: 'prompt', text: 'go' });
      expect(model.state.working).toBe(true);
      sockets[0]?.emitEvent(2, terminal);
      expect(model.state.working).toBe(false);
      resolveActivity({ busy: true, queued: [] });
      await flush();
      expect(model.state.busy).toBe(false);
      expect(model.state.working).toBe(false);
    } finally {
      model.stop();
    }
  });

  it('does not relight a reconciled working indicator on administrative updates', async () => {
    const { connect, sockets } = recordingConnect();
    const client = stubClient();
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    try {
      model.start();
      await flush();
      sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
      sockets[0]?.emitEvent(1, { t: 'prompt', text: 'go' });
      model.refreshActivity();
      await flush();
      expect(model.state.working).toBe(false);
      sockets[0]?.emitEvent(2, { t: 'dev_servers_changed', devServers: [] });
      expect(model.state.session.running).toBe(true);
      expect(model.state.working).toBe(false);
    } finally {
      model.stop();
    }
  });

  it('honours the eager reducer running AHEAD of the poll, then drops it once the server confirms settled', async () => {
    vi.useFakeTimers();
    try {
      const { connect, sockets } = recordingConnect();
      // Server always reports settled (busy:false). The reducer will still flip to
      // running on a live `prompt` — that's the eager, ahead-of-poll case we keep.
      const getActivity = vi.fn().mockResolvedValue({ busy: false, queued: [] });
      const client = {
        sendTurn: vi.fn(),
        getSession: vi.fn().mockResolvedValue({ resumable: true, status: 'idle' }),
        getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
        getActivity,
      } as unknown as VerityClient;
      const workingSeen: boolean[] = [];
      const model = new SessionModel({
        client,
        sessionId: 's1',
        transport: connect,
        onChange: (s) => workingSeen.push(s.working),
      });
      model.start();
      await vi.advanceTimersByTimeAsync(0); // immediate poll (settled at seq 0) + stream open

      // A turn starts: the reducer flips running on the `prompt`, newestSeq advances.
      sockets[0]?.emitEvent(5, { t: 'prompt', text: 'go' });
      sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 5 }));
      expect(model.state.session.running).toBe(true);
      // Eager: a live event arrived AFTER the last settled poll → working, even though
      // the 1.5s poll still says busy:false (it hasn't caught up to the new turn).
      expect(model.state.working).toBe(true);

      // The turn ends server-side but the reducer MISSES its terminal event and stays
      // stuck running. The next settled poll (no newer event since) must win.
      workingSeen.length = 0;
      await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_POLL_MS);
      expect(model.state.session.running).toBe(true); // reducer is still stuck ON
      expect(model.state.working).toBe(false); // reconciled to the authoritative server
      // ...and the flip must be EMITTED (a bare `busy:false` re-anchor can't be swallowed
      // by the no-change short-circuit, or the screen would keep the stale Stop button).
      expect(workingSeen).toContain(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is working whenever the server reports busy, regardless of the reducer', async () => {
    const { connect } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true, status: 'running' }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({ busy: true, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.busy).toBe(true);
    expect(model.state.working).toBe(true);
  });
});

describe('SessionModel — sendTurn', () => {
  it('posts the prompt + options (202) and toggles sending', async () => {
    const { connect } = recordingConnect();
    const sendTurn = vi.fn().mockResolvedValue({ sessionId: 's1', accepted: true });
    const sendingStates: boolean[] = [];
    const model = new SessionModel({
      client: { sendTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      onChange: (s) => sendingStates.push(s.sending),
    });

    await model.sendTurn('go', { permissionMode: 'plan' });

    expect(sendTurn).toHaveBeenCalledWith('s1', { prompt: 'go', permissionMode: 'plan' });
    expect(model.state.sending).toBe(false);
    expect(model.state.sendError).toBeUndefined();
    expect(sendingStates).toContain(true); // emitted sending=true before resolving
  });

  it('echoes a prompt locally while the request is in flight', async () => {
    const { connect } = recordingConnect();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendTurn = vi.fn().mockImplementation(async () => {
      await gate;
      return { sessionId: 's1', accepted: true };
    });
    const model = new SessionModel({
      client: { sendTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    const sending = model.sendTurn('visible immediately');
    expect(model.state.pendingMessages).toMatchObject([
      { text: 'visible immediately', status: 'sending' },
    ]);

    release();
    await sending;
  });

  it('hands a local echo over to the canonical prompt without a duplicate', async () => {
    const { connect, sockets } = recordingConnect();
    const client = {
      ...stubClient(),
      sendTurn: vi.fn().mockResolvedValue({ sessionId: 's1', accepted: true }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();

    await model.sendTurn('hello');
    expect(model.state.pendingMessages).toHaveLength(1);
    sockets[0]?.emitEvent(1, { t: 'prompt', text: 'hello' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));

    expect(model.state.pendingMessages).toEqual([]);
    expect(model.state.session.messages).toMatchObject([{ kind: 'user-text', text: 'hello' }]);
    model.stop();
  });

  it('keeps a failed local echo recoverable until it is dismissed', async () => {
    const { connect } = recordingConnect();
    const model = new SessionModel({
      client: {
        sendTurn: vi.fn().mockRejectedValue(new Error('offline')),
      } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    await model.sendTurn('do not lose me');
    const pending = model.state.pendingMessages[0];
    expect(pending).toMatchObject({ text: 'do not lose me', status: 'failed' });
    expect(model.dismissPending(pending?.id ?? '')).toBe('do not lose me');
    expect(model.state.pendingMessages).toEqual([]);
  });

  it('forwards image attachments to the client', async () => {
    const { connect } = recordingConnect();
    const sendTurn = vi.fn().mockResolvedValue({ sessionId: 's1', accepted: true });
    const model = new SessionModel({
      client: { sendTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    const attachments = [
      { kind: 'image' as const, mediaType: 'image/jpeg' as const, data: 'aGk=' },
    ];

    await model.sendTurn('look', { attachments });

    expect(sendTurn).toHaveBeenCalledWith('s1', { prompt: 'look', attachments });
  });

  it('maps a send failure to sendError (api message vs generic)', async () => {
    const { connect } = recordingConnect();
    const sendTurn = vi.fn();
    const model = new SessionModel({
      client: { sendTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    sendTurn.mockRejectedValueOnce(
      new VerityApiError(409, "session 's1' is busy with another turn"),
    );
    await model.sendTurn('go');
    expect(model.state.sendError).toContain('busy');
    expect(model.state.sending).toBe(false);

    sendTurn.mockRejectedValueOnce(new Error('boom'));
    await model.sendTurn('again');
    expect(model.state.sendError).toBe('failed to send turn');
  });

  it('drops a concurrent send while one is in flight (double-tap guard)', async () => {
    const { connect } = recordingConnect();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendTurn = vi.fn().mockImplementation(async () => {
      await gate; // hold the first turn in flight
      return { sessionId: 's1', accepted: true };
    });
    const model = new SessionModel({
      client: { sendTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    const first = model.sendTurn('one');
    expect(model.state.sending).toBe(true);
    // Second call while the first is still in flight → ignored, no second POST.
    await model.sendTurn('two');
    expect(sendTurn).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(model.state.sending).toBe(false);
    // After it settles, a fresh send goes through normally.
    await model.sendTurn('three');
    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(sendTurn).toHaveBeenLastCalledWith('s1', { prompt: 'three' });
  });

  it('reflects a queued turn (#90) in state and clears it on the next non-queued send', async () => {
    const { connect } = recordingConnect();
    const sendTurn = vi.fn().mockResolvedValue({ sessionId: 's1', accepted: true, queued: true });
    const model = new SessionModel({
      client: { sendTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    await model.sendTurn('while busy');
    expect(model.state.queued).toBe(true);

    // A turn that dispatches immediately (queued: false) clears the hint.
    sendTurn.mockResolvedValueOnce({ sessionId: 's1', accepted: true, queued: false });
    await model.sendTurn('now free');
    expect(model.state.queued).toBe(false);
  });
});

describe('SessionModel — cancel (#79)', () => {
  it('calls cancelTurn and leaves no error on success (incl. a no-op)', async () => {
    const { connect } = recordingConnect();
    const cancelTurn = vi.fn().mockResolvedValue({ sessionId: 's1', cancelled: false });
    const onTurnCancelled = vi.fn();
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), cancelTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      onTurnCancelled,
    });

    await model.cancel();

    expect(cancelTurn).toHaveBeenCalledWith('s1', undefined);
    expect(model.state.cancelError).toBeUndefined();
    expect(onTurnCancelled).not.toHaveBeenCalled();
  });

  it('forwards force and clears the termination banner once the server confirms it', async () => {
    // The flag is server-owned, but the release has already happened by the time this
    // resolves — waiting a poll interval to drop the banner would make the button look
    // broken. Only `forceReleased` may clear it, so a no-op force leaves it standing.
    const { connect } = recordingConnect();
    const cancelTurn = vi
      .fn()
      .mockResolvedValue({ sessionId: 's1', cancelled: false, forceReleased: true });
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), cancelTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    await model.cancel({ force: true });

    expect(cancelTurn).toHaveBeenCalledWith('s1', { force: true });
    expect(model.state.terminationUnconfirmed).toBe(false);
  });

  it('leaves the termination banner up when a force released nothing', async () => {
    const { connect } = recordingConnect();
    const cancelTurn = vi
      .fn()
      .mockResolvedValue({ sessionId: 's1', cancelled: false, forceReleased: false });
    const getActivity = vi
      .fn()
      .mockResolvedValue({ busy: true, queued: [], terminationUnconfirmed: true });
    const model = new SessionModel({
      client: { ...stubClient(), cancelTurn, getActivity } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    await (model as unknown as { loadActivity(): Promise<void> }).loadActivity();
    expect(model.state.terminationUnconfirmed).toBe(true);

    await model.cancel({ force: true });

    expect(model.state.terminationUnconfirmed).toBe(true);
  });

  it('returns dropped queued prompts for the composer and clears waiting bubbles', async () => {
    const { connect } = recordingConnect();
    const cancelTurn = vi.fn().mockResolvedValue({
      sessionId: 's1',
      cancelled: true,
      droppedQueued: [
        {
          id: 'q1',
          prompt: 'first',
          attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
        },
        { id: 'q2', prompt: 'second' },
      ],
    });
    const onTurnCancelled = vi.fn();
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), cancelTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      onTurnCancelled,
    });

    await expect(model.cancel()).resolves.toEqual([
      {
        prompt: 'first',
        attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
      },
      { prompt: 'second' },
    ]);
    expect(model.state.waitingMessages).toEqual([]);
    expect(onTurnCancelled).toHaveBeenCalledOnce();
  });

  it('maps a cancel failure to cancelError (api message vs generic)', async () => {
    const { connect } = recordingConnect();
    const cancelTurn = vi.fn();
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), cancelTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    cancelTurn.mockRejectedValueOnce(new VerityApiError(404, 'session s1 not found'));
    await model.cancel();
    expect(model.state.cancelError).toContain('not found');

    cancelTurn.mockRejectedValueOnce(new Error('network boom'));
    await model.cancel();
    expect(model.state.cancelError).toBe('failed to stop turn');
  });

  it('clears a stale cancelError when the next turn is sent', async () => {
    const { connect } = recordingConnect();
    const cancelTurn = vi.fn().mockRejectedValue(new VerityApiError(404, 'gone'));
    const sendTurn = vi.fn().mockResolvedValue({ sessionId: 's1', accepted: true });
    const model = new SessionModel({
      client: { sendTurn, cancelTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    await model.cancel();
    expect(model.state.cancelError).toBeDefined();
    await model.sendTurn('next');
    expect(model.state.cancelError).toBeUndefined();
  });
});

describe('SessionModel — resumable', () => {
  it('loads the resumable flag from the session detail on start', async () => {
    const { connect } = recordingConnect();
    const getSession = vi.fn().mockResolvedValue({ resumable: false });
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), getSession } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    expect(model.state.resumable).toBeUndefined(); // unknown until the detail loads
    model.start();
    await vi.waitFor(() => {
      expect(model.state.resumable).toBe(false);
    });
    expect(getSession).toHaveBeenCalledWith('s1', { trace: undefined });
  });

  it('stays undefined (sendable) when the detail probe fails', async () => {
    const { connect } = recordingConnect();
    const getSession = vi.fn().mockRejectedValue(new Error('network'));
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), getSession } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    model.start();
    await vi.waitFor(() => {
      expect(getSession).toHaveBeenCalled();
    });
    // A flaky probe must not block sending — leave it undefined, not false.
    expect(model.state.resumable).toBeUndefined();
  });

  it('flips resumable to false when a send 410s (worktree vanished since load)', async () => {
    const { connect } = recordingConnect();
    const sendTurn = vi
      .fn()
      .mockRejectedValueOnce(new VerityApiError(410, 'its workspace no longer exists'));
    const model = new SessionModel({
      client: {
        sendTurn,
        getSession: vi.fn().mockResolvedValue({ resumable: true }),
      } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    await model.sendTurn('go');
    expect(model.state.sendError).toContain('workspace no longer exists');
    expect(model.state.resumable).toBe(false); // disable further sends
  });

  it('does not let a slow resumable=true probe clobber a latched 410', async () => {
    const { connect } = recordingConnect();
    const sendTurn = vi.fn().mockRejectedValueOnce(new VerityApiError(410, 'gone'));
    // The detail probe answers "still alive" (stale — the worktree existed when it
    // was issued); it must NOT re-enable a session the 410 already proved dead.
    const getSession = vi.fn().mockResolvedValue({ resumable: true });
    const model = new SessionModel({
      client: { sendTurn, getSession } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    await model.sendTurn('go'); // 410 → latches resumable false
    expect(model.state.resumable).toBe(false);
    model.start(); // fires the (stale) probe
    await vi.waitFor(() => {
      expect(getSession).toHaveBeenCalled();
    });
    expect(model.state.resumable).toBe(false); // not clobbered back to true
  });
});

describe('SessionModel — name', () => {
  it('exposes the display name from the session detail on start', async () => {
    const { connect } = recordingConnect();
    const getSession = vi.fn().mockResolvedValue({ resumable: true, name: 'refactor auth' });
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), getSession } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    expect(model.state.name).toBeUndefined(); // unknown until the detail loads
    model.start();
    await vi.waitFor(() => {
      expect(model.state.name).toBe('refactor auth');
    });
  });

  it('exposes a null name (no name set) once the detail loads', async () => {
    const { connect } = recordingConnect();
    const getSession = vi.fn().mockResolvedValue({ resumable: true, name: null });
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), getSession } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    model.start();
    await vi.waitFor(() => {
      expect(getSession).toHaveBeenCalled();
    });
    expect(model.state.name).toBeNull();
  });

  it('leaves the name undefined when the detail probe fails', async () => {
    const { connect } = recordingConnect();
    const getSession = vi.fn().mockRejectedValue(new Error('network'));
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), getSession } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    model.start();
    await vi.waitFor(() => {
      expect(getSession).toHaveBeenCalled();
    });
    expect(model.state.name).toBeUndefined();
  });
});

describe('SessionModel — switchModel (engine switch)', () => {
  it('exposes the current model + project from the session detail on start', async () => {
    const { connect } = recordingConnect();
    const getSession = vi
      .fn()
      .mockResolvedValue({ resumable: true, model: 'codex/default', projectId: 'p1' });
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), getSession } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    expect(model.state.model).toBeUndefined(); // unknown until the detail loads
    model.start();
    await vi.waitFor(() => {
      expect(model.state.model).toBe('codex/default');
    });
    expect(model.state.projectId).toBe('p1');
  });

  it('PATCHes the new model and reflects it (persisted choice, not a one-turn override)', async () => {
    const { connect } = recordingConnect();
    const setSessionModel = vi
      .fn()
      .mockResolvedValue({ sessionId: 's1', model: 'codex/default', deferred: false });
    const model = new SessionModel({
      client: {
        getSession: vi.fn().mockResolvedValue({ resumable: true }),
        setSessionModel,
      } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    await model.switchModel('codex/default');

    expect(setSessionModel).toHaveBeenCalledWith('s1', 'codex/default');
    expect(model.state.model).toBe('codex/default');
    expect(model.state.switchingModel).toBe(false);
    expect(model.state.modelSwitchPending).toBe(false);
    expect(model.state.switchModelError).toBeUndefined();
  });

  it('keeps a deferred-switch notice until a later activity request observes idle', async () => {
    const { connect } = recordingConnect();
    let resolveStaleActivity: ((value: { busy: boolean; queued: never[] }) => void) | undefined;
    const staleActivity = new Promise<{ busy: boolean; queued: never[] }>((resolve) => {
      resolveStaleActivity = resolve;
    });
    const getActivity = vi.fn().mockReturnValueOnce(staleActivity);
    const model = new SessionModel({
      client: {
        ...stubClient(),
        getActivity,
        setSessionModel: vi
          .fn()
          .mockResolvedValue({ sessionId: 's1', model: 'codex/default', deferred: true }),
      } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    const loadActivity = (): Promise<void> =>
      (
        model as unknown as {
          loadActivity(): Promise<void>;
        }
      ).loadActivity();

    const staleLoad = loadActivity();
    await model.switchModel('codex/default');
    expect(model.state.modelSwitchPending).toBe(true);

    resolveStaleActivity?.({ busy: false, queued: [] });
    await staleLoad;
    expect(model.state.modelSwitchPending).toBe(true);

    getActivity.mockResolvedValueOnce({ busy: true, queued: [], modelSwitchPending: false });
    await loadActivity();
    expect(model.state.modelSwitchPending).toBe(false);
  });

  // The server owns the pending bit outright: it is true for as long as the handover
  // holds the barrier, so any client polling during one adopts it — including one that
  // mounted after the switch was issued, and one that never issued it at all.
  it('rehydrates the model-switch notice from activity after a remount', async () => {
    const { connect } = recordingConnect();
    const getActivity = vi
      .fn()
      .mockResolvedValueOnce({ busy: true, queued: [], modelSwitchPending: true })
      .mockResolvedValueOnce({ busy: true, queued: [], modelSwitchPending: false });
    const model = new SessionModel({
      client: { ...stubClient(), getActivity } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    const loadActivity = (): Promise<void> =>
      (
        model as unknown as {
          loadActivity(): Promise<void>;
        }
      ).loadActivity();

    await loadActivity();
    expect(model.state.modelSwitchPending).toBe(true);

    await loadActivity();
    expect(model.state.modelSwitchPending).toBe(false);
  });

  it('surfaces a busy-because-unconfirmed session and clears it when the server frees it', async () => {
    // `busy: true` with nothing running is indistinguishable from an endless turn
    // unless the reason is carried through. The server owns both edges — it retries
    // the kill by itself — so the model just mirrors the flag rather than latching it.
    const { connect } = recordingConnect();
    const getActivity = vi
      .fn()
      .mockResolvedValueOnce({ busy: true, queued: [], terminationUnconfirmed: true })
      .mockResolvedValueOnce({ busy: false, queued: [], terminationUnconfirmed: false });
    const model = new SessionModel({
      client: { ...stubClient(), getActivity } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    const loadActivity = (): Promise<void> =>
      (model as unknown as { loadActivity(): Promise<void> }).loadActivity();

    await loadActivity();
    expect(model.state.terminationUnconfirmed).toBe(true);
    expect(model.state.busy).toBe(true);

    await loadActivity();
    expect(model.state.terminationUnconfirmed).toBe(false);
  });

  it('reads an older server that omits terminationUnconfirmed as confirmed', async () => {
    // Absent is not "unknown": a server that never reports the field also never holds
    // the fence this way, so `false` is the honest read — not a banner the operator
    // can neither act on nor dismiss.
    const { connect } = recordingConnect();
    const getActivity = vi.fn().mockResolvedValue({ busy: true, queued: [] });
    const model = new SessionModel({
      client: { ...stubClient(), getActivity } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    await (model as unknown as { loadActivity(): Promise<void> }).loadActivity();
    expect(model.state.terminationUnconfirmed).toBe(false);
  });

  it('clears the session-local rate-limit banner after a successful model switch', async () => {
    const { connect, sockets } = recordingConnect();
    const setSessionModel = vi.fn().mockResolvedValue({ sessionId: 's1', model: 'codex/default' });
    const model = new SessionModel({
      client: { ...stubClient(), setSessionModel } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    model.start();
    await flush();
    sockets[0]?.emitEvent(1, {
      t: 'rate_limit',
      status: 'rejected',
      resetsAt: 1_700_000_000,
      window: 'five_hour',
    });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(model.state.session.rateLimit).toEqual({
      status: 'rejected',
      resetsAt: 1_700_000_000,
      window: 'five_hour',
      providerLabel: 'Claude',
    });

    await model.switchModel('codex/default');

    expect(model.state.session.rateLimit).toBeUndefined();
  });

  it('does not resurrect a cleared rate-limit when older history is prepended', async () => {
    const { connect, sockets } = recordingConnect();
    const getHistory = vi
      .fn()
      .mockResolvedValueOnce({
        events: [{ seq: 99, event: { t: 'text', delta: 'tail A' } }],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [
          {
            seq: 50,
            event: {
              t: 'rate_limit',
              status: 'rejected',
              resetsAt: 1_700_000_000,
              window: 'five_hour',
              providerLabel: 'Claude',
            },
          },
          { seq: 51, event: { t: 'prompt', text: 'older Q' } },
        ],
        hasMore: false,
      });
    const setSessionModel = vi.fn().mockResolvedValue({ sessionId: 's1', model: 'codex/default' });
    const model = new SessionModel({
      client: { ...stubClient(), getHistory, setSessionModel } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    model.start();
    await flush();
    sockets[0]?.emitEvent(100, {
      t: 'rate_limit',
      status: 'rejected',
      resetsAt: 1_700_000_000,
      window: 'five_hour',
      providerLabel: 'Claude',
    });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 100 }));
    expect(model.state.session.rateLimit).toMatchObject({ providerLabel: 'Claude' });

    await model.switchModel('codex/default');
    await model.loadOlder();

    expect(model.state.session.rateLimit).toBeUndefined();
  });

  it('does not restore a stale detail rate-limit after a successful model switch', async () => {
    const { connect } = recordingConnect();
    let resolveDetail: (value: unknown) => void = () => undefined;
    const getSession = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );
    const setSessionModel = vi.fn().mockResolvedValue({ sessionId: 's1', model: 'codex/default' });
    const model = new SessionModel({
      client: {
        ...stubClient(),
        getSession,
        setSessionModel,
      } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    model.start();
    await flush();

    await model.switchModel('codex/default');
    resolveDetail({
      resumable: true,
      model: 'claude-sonnet-4-6',
      rateLimit: {
        status: 'rejected',
        resetsAt: 1_700_000_000,
        window: 'five_hour',
        providerLabel: 'Claude',
      },
    });

    await vi.waitFor(() => {
      expect(getSession).toHaveBeenCalled();
      expect(model.state.session.rateLimit).toBeUndefined();
    });
  });

  it('ignores a detail rate-limit for a provider that no longer matches the model', async () => {
    const { connect } = recordingConnect();
    const client = {
      ...stubClient(),
      getSession: vi.fn().mockResolvedValue({
        resumable: true,
        model: 'codex/default',
        rateLimit: {
          status: 'rejected',
          resetsAt: 1_700_000_000,
          window: 'five_hour',
          providerLabel: 'Claude',
        },
      }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });

    model.start();
    await vi.waitFor(() => {
      expect(model.state.model).toBe('codex/default');
      expect(model.state.session.rateLimit).toBeUndefined();
    });
  });

  it('uses the detail rate-limit matching the current model provider', async () => {
    const { connect } = recordingConnect();
    const client = {
      ...stubClient(),
      getSession: vi.fn().mockResolvedValue({
        resumable: true,
        model: 'codex/default',
        rateLimits: [
          {
            status: 'rejected',
            resetsAt: 1_700_000_300,
            window: 'five_hour',
            providerLabel: 'Claude',
          },
          {
            status: 'rejected',
            resetsAt: 1_700_000_400,
            window: 'weekly',
            scope: 'sonnet',
            providerLabel: 'Codex',
          },
          {
            status: 'rejected',
            resetsAt: 1_700_000_200,
            window: 'five_hour',
            providerLabel: 'Codex',
          },
        ],
      }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });

    model.start();

    await vi.waitFor(() => {
      expect(model.state.session.rateLimit).toEqual({
        status: 'rejected',
        resetsAt: 1_700_000_200,
        window: 'five_hour',
        providerLabel: 'Codex',
      });
    });
  });

  it('restores the detail rate-limit when switching back to the limited provider', async () => {
    const { connect } = recordingConnect();
    const getSession = vi.fn().mockResolvedValue({
      resumable: true,
      model: 'claude-sonnet-4-6',
      rateLimit: {
        status: 'rejected',
        resetsAt: 1_700_000_000,
        window: 'five_hour',
        providerLabel: 'Claude',
      },
    });
    const setSessionModel = vi.fn(async (_id: string, model: string) => ({
      sessionId: 's1',
      model,
    }));
    const model = new SessionModel({
      client: {
        ...stubClient(),
        getSession,
        setSessionModel,
      } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    model.start();
    await vi.waitFor(() => {
      expect(model.state.session.rateLimit).toMatchObject({ providerLabel: 'Claude' });
    });

    await model.switchModel('codex/default');
    await vi.waitFor(() => {
      expect(model.state.model).toBe('codex/default');
      expect(model.state.session.rateLimit).toBeUndefined();
    });

    await model.switchModel('claude-sonnet-4-6');

    await vi.waitFor(() => {
      expect(model.state.model).toBe('claude-sonnet-4-6');
      expect(model.state.session.rateLimit).toMatchObject({ providerLabel: 'Claude' });
    });
  });

  it('surfaces a switch failure and leaves the model unchanged', async () => {
    const { connect } = recordingConnect();
    const setSessionModel = vi
      .fn()
      .mockRejectedValue(
        new VerityApiError(400, 'project sessions currently support Claude and Codex models only'),
      );
    const model = new SessionModel({
      client: {
        getSession: vi.fn().mockResolvedValue({ resumable: true, model: 'claude-opus-4-8' }),
        setSessionModel,
      } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    model.start();
    await vi.waitFor(() => {
      expect(model.state.model).toBe('claude-opus-4-8');
    });

    await model.switchModel('deepinfra/zai-org/GLM-5');

    expect(model.state.switchModelError).toContain('Claude and Codex');
    expect(model.state.model).toBe('claude-opus-4-8'); // unchanged on failure
    expect(model.state.switchingModel).toBe(false);
  });

  it('is a no-op when already on the requested model', async () => {
    const { connect } = recordingConnect();
    const setSessionModel = vi.fn();
    const model = new SessionModel({
      client: {
        getSession: vi.fn().mockResolvedValue({ resumable: true, model: 'codex/default' }),
        setSessionModel,
      } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    model.start();
    await vi.waitFor(() => {
      expect(model.state.model).toBe('codex/default');
    });

    await model.switchModel('codex/default');

    expect(setSessionModel).not.toHaveBeenCalled();
  });
});

describe('SessionModel — loadOlder (backward pagination)', () => {
  it.each(['page', 'bookmark'] as const)(
    'publishes %s history once with final paging flags',
    async (mode) => {
      const { connect } = recordingConnect();
      const client = stubClient();
      client.getHistory = vi
        .fn()
        .mockResolvedValueOnce({
          events: [{ seq: 100, event: { t: 'text', delta: 'tail' } }],
          hasMore: true,
        })
        .mockResolvedValueOnce({
          events: [{ seq: 50, event: { t: 'prompt', text: 'older' } }],
          hasMore: false,
        });
      const updates: SessionModelState[] = [];
      const model = new SessionModel({
        client,
        sessionId: 's1',
        transport: connect,
        onChange: (state) => updates.push(state),
      });
      model.start();
      await flush();
      updates.length = 0;
      if (mode === 'page') await model.loadOlder();
      else await model.loadOlderUntil(50);
      // New rows paired with stale paging flags make the list anchor twice.
      expect(
        updates.map((state) => ({
          loading: state.loadingOlder,
          hasOlder: state.hasOlder,
          generation: state.olderLoadGeneration,
          rows: state.session.messages.length,
        })),
      ).toEqual([
        { loading: true, hasOlder: true, generation: 0, rows: 1 },
        { loading: false, hasOlder: false, generation: 1, rows: 2 },
      ]);
      model.stop();
    },
  );

  it('reduces a visible older page only for visibility and canonical replay', async () => {
    const { connect } = recordingConnect();
    const client = stubClient();
    client.getHistory = vi
      .fn()
      .mockResolvedValueOnce({
        events: [{ seq: 100, event: { t: 'text', delta: 'tail' } }],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [{ seq: 50, event: { t: 'prompt', text: 'older' } }],
        hasMore: true,
      });
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    const apply = vi.spyOn(SessionReducer.prototype, 'applyFrame');
    try {
      await model.loadOlder();
      expect(apply.mock.calls.filter(([frame]) => frame.seq === 50)).toHaveLength(2);
    } finally {
      apply.mockRestore();
      model.stop();
    }
  });

  it('opens from the tail, then loads + prepends an older page on demand', async () => {
    const { connect, sockets } = recordingConnect();
    const getHistory = vi
      .fn()
      // tail-open probe: older history exists before seq 100.
      .mockResolvedValueOnce({
        events: [{ seq: 100, event: { t: 'text', delta: 'tail A' } }],
        hasMore: true,
      })
      // loadOlder: the previous page (a prompt), nothing older left.
      .mockResolvedValueOnce({
        events: [{ seq: 50, event: { t: 'prompt', text: 'older Q' } }],
        hasMore: false,
      });
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory,
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });

    model.start();
    await flush();
    // Tail was seeded by REST; the stream resumes after that snapshot.
    expect(sockets[0]?.sinceSeq).toBe(100);
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 100 }));
    expect(model.state.hasOlder).toBe(true);

    await model.loadOlder();

    expect(getHistory).toHaveBeenNthCalledWith(2, 's1', { beforeSeq: 100, limit: 150 });
    expect(model.state.hasOlder).toBe(false); // nothing older left
    expect(model.state.loadingOlder).toBe(false);
    // Older prompt is prepended before the tail's agent text.
    expect(model.state.session.messages[0]).toMatchObject({ kind: 'user-text', text: 'older Q' });
    expect(agentTexts(model.state)).toEqual(['tail A']);
  });

  it('is a no-op when there is nothing older to load', async () => {
    const { connect } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      // short session: tail-open returns no-more → hasOlder stays false.
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.hasOlder).toBe(false);

    await model.loadOlder();
    // Only the initial tail-open probe ran; loadOlder didn't fetch.
    expect((client.getHistory as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('continues through event-only pages until older transcript rows are visible', async () => {
    const { connect, sockets } = recordingConnect();
    const getHistory = vi
      .fn()
      .mockResolvedValueOnce({
        events: [{ seq: 300, event: { t: 'text', delta: 'tail' } }],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [metadataHistoryEvent(200)],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [{ seq: 100, event: { t: 'prompt', text: 'visible older prompt' } }],
        hasMore: false,
      });
    const client = {
      ...stubClient(),
      getHistory,
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });

    model.start();
    await flush();
    sockets[0]?.emitEvent(300, { t: 'text', delta: 'tail' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 300 }));

    await model.loadOlder();

    expect(getHistory).toHaveBeenNthCalledWith(2, 's1', { beforeSeq: 300, limit: 150 });
    expect(getHistory).toHaveBeenNthCalledWith(3, 's1', { beforeSeq: 200, limit: 150 });
    expect(model.state.session.messages[0]).toMatchObject({
      kind: 'user-text',
      text: 'visible older prompt',
    });
    expect(model.state.hasOlder).toBe(false);
  });

  it('bounds scans through metadata-only history pages', async () => {
    const { connect, sockets } = recordingConnect();
    const getHistory = vi.fn().mockResolvedValueOnce({
      events: [{ seq: 1000, event: { t: 'text', delta: 'tail' } }],
      hasMore: true,
    });
    for (const seq of [900, 800, 700, 600, 500, 400]) {
      getHistory.mockResolvedValueOnce({
        events: [metadataHistoryEvent(seq)],
        hasMore: seq !== 400,
      });
    }
    const model = new SessionModel({
      client: { ...stubClient(), getHistory } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    model.start();
    await flush();
    sockets[0]?.emitEvent(1000, { t: 'text', delta: 'tail' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1000 }));
    await model.loadOlder();

    expect(getHistory).toHaveBeenCalledTimes(6); // tail probe + at most five scan pages
    expect(model.state.hasOlder).toBe(true);
    expect(model.state.olderLoadStalled).toBe(false);
    expect(model.state.olderLoadNeedsContinuation).toBe(true);
    expect(model.state.olderLoadGeneration).toBe(1);
    // Navigation must see cursor progress even when the bounded scan added no rows.
    expect(model.state.oldestHistorySeq).toBe(500);
    await model.loadOlder();
    expect(getHistory).toHaveBeenNthCalledWith(7, 's1', { beforeSeq: 500, limit: 150 });
    expect(model.state.oldestHistorySeq).toBe(400);
  });

  it('keeps successful metadata pages when a later scan request fails', async () => {
    const { connect, sockets } = recordingConnect();
    const getHistory = vi
      .fn()
      .mockResolvedValueOnce({
        events: [{ seq: 300, event: { t: 'text', delta: 'tail' } }],
        hasMore: true,
      })
      .mockResolvedValueOnce({ events: [metadataHistoryEvent(200)], hasMore: true })
      .mockRejectedValueOnce(new Error('temporary history failure'))
      .mockResolvedValueOnce({
        events: [{ seq: 100, event: { t: 'prompt', text: 'older prompt after retry' } }],
        hasMore: false,
      });
    const model = new SessionModel({
      client: { ...stubClient(), getHistory } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    model.start();
    await flush();
    sockets[0]?.emitEvent(300, { t: 'text', delta: 'tail' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 300 }));
    await model.loadOlder();
    expect(model.state.olderLoadStalled).toBe(true);
    expect(model.state.olderLoadNeedsContinuation).toBe(false);
    expect(model.state.olderLoadGeneration).toBe(1);
    await model.loadOlder();

    expect(getHistory).toHaveBeenNthCalledWith(4, 's1', { beforeSeq: 200, limit: 150 });
    expect(model.state.session.messages[0]).toMatchObject({
      kind: 'user-text',
      text: 'older prompt after retry',
    });
    expect(model.state.hasOlder).toBe(false);
    expect(model.state.olderLoadStalled).toBe(false);
    expect(model.state.olderLoadNeedsContinuation).toBe(false);
    expect(model.state.olderLoadGeneration).toBe(2);
  });
});

describe('SessionModel — server activity + queued messages', () => {
  it('pauses the socket and activity polling in background, then resumes both', async () => {
    vi.useFakeTimers();
    try {
      const { connect, sockets } = recordingConnect();
      const getActivity = vi.fn().mockResolvedValue({ busy: false, queued: [] });
      const client = { ...stubClient(), getActivity } as unknown as VerityClient;
      const model = new SessionModel({ client, sessionId: 's1', transport: connect });

      model.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      expect(getActivity).toHaveBeenCalledOnce();

      model.pause();
      expect(sockets[0]?.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(getActivity).toHaveBeenCalledOnce();

      model.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      expect(getActivity).toHaveBeenCalledTimes(2);
      model.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces server-authoritative busy + waiting messages on the initial poll', async () => {
    const { connect } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi
        .fn()
        .mockResolvedValue({ busy: true, queued: [{ id: 'q1', text: 'waiting one' }] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.busy).toBe(true);
    expect(model.state.waitingMessages).toEqual([{ id: 'q1', text: 'waiting one' }]);
    model.stop();
  });

  it('surfaces the live branch from the activity poll (#110)', async () => {
    const { connect } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [], branch: 'feat/122-x' }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.branch).toBe('feat/122-x');
    model.stop();
  });

  it('adopts an auto-generated name reported by a later activity poll (#auto-title)', async () => {
    vi.useFakeTimers();
    try {
      const { connect } = recordingConnect();
      const getActivity = vi
        .fn()
        .mockResolvedValueOnce({ busy: false, queued: [], name: null })
        .mockResolvedValue({ busy: false, queued: [], name: 'Auth Refactor' });
      const client = {
        sendTurn: vi.fn(),
        getSession: vi.fn().mockResolvedValue({ resumable: true, name: null }),
        getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
        getActivity,
      } as unknown as VerityClient;
      const model = new SessionModel({ client, sessionId: 's1', transport: connect });
      model.start();
      await vi.advanceTimersByTimeAsync(0); // immediate first poll → still unnamed
      expect(model.state.name).toBeNull();
      await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_POLL_MS); // next poll → auto-title landed server-side
      expect(model.state.name).toBe('Auth Refactor');
      model.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the load-once name when the activity poll omits it (older server)', async () => {
    const { connect } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true, name: 'From Detail' }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.name).toBe('From Detail');
    model.stop();
  });

  it('prunes an expired rate-limit state on an otherwise unchanged activity poll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    try {
      const { connect } = recordingConnect();
      const client = {
        sendTurn: vi.fn(),
        getSession: vi.fn().mockResolvedValue({
          resumable: true,
          model: 'codex/default',
          rateLimit: {
            status: 'rejected',
            resetsAt: 101,
            window: 'five_hour',
            providerLabel: 'Codex',
          },
        }),
        getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
        getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
      } as unknown as VerityClient;
      const model = new SessionModel({ client, sessionId: 's1', transport: connect });

      model.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(model.state.session.rateLimit).toEqual({
        status: 'rejected',
        resetsAt: 101,
        window: 'five_hour',
        providerLabel: 'Codex',
      });

      vi.setSystemTime(new Date(102_000));
      await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_POLL_MS);

      expect(model.state.session.rateLimit).toBeUndefined();
      model.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the live branch when a later poll reports a different one (#110)', async () => {
    vi.useFakeTimers();
    try {
      const { connect } = recordingConnect();
      const getActivity = vi
        .fn()
        .mockResolvedValueOnce({ busy: false, queued: [], branch: 'main' })
        .mockResolvedValue({ busy: false, queued: [], branch: 'feat/122-x' });
      const client = {
        sendTurn: vi.fn(),
        getSession: vi.fn().mockResolvedValue({ resumable: true }),
        getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
        getActivity,
      } as unknown as VerityClient;
      const model = new SessionModel({ client, sessionId: 's1', transport: connect });
      model.start();
      await vi.advanceTimersByTimeAsync(0); // immediate first poll
      expect(model.state.branch).toBe('main');
      await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_POLL_MS); // next interval poll → external checkout
      expect(model.state.branch).toBe('feat/122-x');
      model.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips an overlapping activity poll while a prior one is still in flight (#110)', async () => {
    vi.useFakeTimers();
    try {
      const { connect } = recordingConnect();
      let resolveFirst: (v: { busy: boolean; queued: string[] }) => void = () => {};
      const first = new Promise<{ busy: boolean; queued: string[] }>((r) => {
        resolveFirst = r;
      });
      const getActivity = vi
        .fn()
        .mockReturnValueOnce(first) // first poll hangs (slow git read)
        .mockResolvedValue({ busy: false, queued: [] });
      const client = {
        sendTurn: vi.fn(),
        getSession: vi.fn().mockResolvedValue({ resumable: true }),
        getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
        getActivity,
      } as unknown as VerityClient;
      const model = new SessionModel({ client, sessionId: 's1', transport: connect });
      model.start();
      await vi.advanceTimersByTimeAsync(0); // first poll starts, then hangs
      await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_POLL_MS); // interval ticks → must be skipped
      await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_POLL_MS); // and again
      expect(getActivity).toHaveBeenCalledTimes(1); // overlap guard held
      resolveFirst({ busy: false, queued: [] }); // the slow poll finally resolves
      await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_POLL_MS); // next tick is allowed now
      expect(getActivity).toHaveBeenCalledTimes(2);
      model.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces live hints during an outstanding activity request', async () => {
    vi.useFakeTimers();
    try {
      const { connect } = recordingConnect();
      let resolveFirst: (v: { busy: boolean; queued: string[] }) => void = () => {};
      const first = new Promise<{ busy: boolean; queued: string[] }>((r) => {
        resolveFirst = r;
      });
      const getActivity = vi
        .fn()
        .mockReturnValueOnce(first) // first poll hangs (slow git read)
        .mockResolvedValue({ busy: false, queued: [] });
      const client = {
        sendTurn: vi.fn(),
        getSession: vi.fn().mockResolvedValue({ resumable: true }),
        getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
        getActivity,
      } as unknown as VerityClient;
      const model = new SessionModel({ client, sessionId: 's1', transport: connect });
      model.start();
      await vi.advanceTimersByTimeAsync(0); // first poll starts, then hangs
      model.refreshActivity();
      model.refreshActivity();
      expect(getActivity).toHaveBeenCalledTimes(1); // overlap guard held
      resolveFirst({ busy: false, queued: [] }); // the slow poll finally resolves
      await vi.advanceTimersByTimeAsync(0); // hints must refresh without waiting for a poll
      expect(getActivity).toHaveBeenCalledTimes(2);
      model.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a queued send visible until its prompt event lands (duplicate-counted)', async () => {
    const { connect, sockets } = recordingConnect();
    const client = {
      sendTurn: vi.fn().mockResolvedValue({ sessionId: 's1', accepted: true, queued: true }),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();

    await model.sendTurn('dup');
    await model.sendTurn('dup'); // both queued behind the in-flight turn
    expect(model.state.queuedMessages).toEqual(['dup', 'dup']);

    // The first 'dup' runs → one matching prompt event lands → one still pending.
    sockets[0]?.emitEvent(1, { t: 'prompt', text: 'dup' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(model.state.queuedMessages).toEqual(['dup']);
    model.stop();
  });

  it('drops a waiting message once its prompt event lands — no duplicate bubble', async () => {
    const { connect, sockets } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      // The server still reports the message as queued (poll lag / not yet dequeued).
      getActivity: vi
        .fn()
        .mockResolvedValue({ busy: true, queued: [{ id: 'q1', text: 'hello there' }] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.waitingMessages).toEqual([{ id: 'q1', text: 'hello there' }]); // shown while queued

    // It's delivered: a matching prompt event lands as a solid user-text bubble. The
    // "waiting to send" bubble must vanish immediately (not wait for the next poll),
    // so the message isn't shown twice.
    sockets[0]?.emitEvent(1, { t: 'prompt', text: 'hello there' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(model.state.waitingMessages).toEqual([]);
    model.stop();
  });

  it('does not treat a peer message with the same text as a delivered user turn', async () => {
    const { connect, sockets } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi
        .fn()
        .mockResolvedValue({ busy: true, queued: [{ id: 'q1', text: 'same words' }] }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    sockets[0]?.emitEvent(1, {
      t: 'prompt',
      text: 'Untrusted peer envelope',
      peer: {
        sessionId: 'peer',
        projectId: 'project-b',
        label: 'B · peer',
        message: 'same words',
      },
    });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(model.state.waitingMessages).toEqual([{ id: 'q1', text: 'same words' }]);
    model.stop();
  });

  it('does not let an older identical prompt hide a newly observed waiting message', async () => {
    const { connect, sockets } = recordingConnect();
    let resolveActivity!: (value: {
      busy: boolean;
      queued: Array<{ id: string; text: string }>;
    }) => void;
    const activity = new Promise<{
      busy: boolean;
      queued: Array<{ id: string; text: string }>;
    }>((resolve) => {
      resolveActivity = resolve;
    });
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockReturnValue(activity),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();

    sockets[0]?.emitEvent(7, { t: 'prompt', text: 'ok' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 7 }));
    resolveActivity({ busy: true, queued: [{ id: 'q-new', text: 'ok' }] });
    await flush();
    expect(model.state.waitingMessages).toEqual([{ id: 'q-new', text: 'ok' }]);

    sockets[0]?.emitEvent(8, { t: 'prompt', text: 'ok' });
    expect(model.state.waitingMessages).toEqual([]);
    model.stop();
  });

  it('keeps one of two identical waiting messages when only one is delivered', async () => {
    const { connect, sockets } = recordingConnect();
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({
        busy: true,
        queued: [
          { id: 'q1', text: 'dup' },
          { id: 'q2', text: 'dup' },
        ],
      }),
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.waitingMessages).toEqual([
      { id: 'q1', text: 'dup' },
      { id: 'q2', text: 'dup' },
    ]);

    // One 'dup' is delivered → count-aware subtraction drops the FIRST occurrence,
    // leaving exactly one waiting item (the second, with its own retract id).
    sockets[0]?.emitEvent(1, { t: 'prompt', text: 'dup' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(model.state.waitingMessages).toEqual([{ id: 'q2', text: 'dup' }]);
    model.stop();
  });

  it('cancelWaiting retracts a queued turn and returns its text to edit (#80)', async () => {
    const { connect } = recordingConnect();
    const cancelQueued = vi.fn().mockResolvedValue({
      sessionId: 's1',
      itemId: 'q1',
      prompt: 'fix me',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
    });
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({
        busy: true,
        queued: [{ id: 'q1', text: 'fix me' }],
      }),
      cancelQueued,
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();
    expect(model.state.waitingMessages).toEqual([{ id: 'q1', text: 'fix me' }]);

    const text = await model.cancelWaiting('q1');
    expect(text).toEqual({
      prompt: 'fix me',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
    }); // handed back so the screen can refill the input
    expect(cancelQueued).toHaveBeenCalledWith('s1', 'q1');
    // The bubble is dropped immediately (server confirmed), not left to the next poll.
    expect(model.state.waitingMessages).toEqual([]);
    model.stop();
  });

  it('cancelWaiting drops a stale bubble (404) without text to restore (#80)', async () => {
    const { connect } = recordingConnect();
    const cancelQueued = vi.fn().mockRejectedValue(new VerityApiError(404, 'not found'));
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({
        busy: true,
        queued: [{ id: 'q1', text: 'already running' }],
      }),
      cancelQueued,
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();

    const text = await model.cancelWaiting('q1');
    expect(text).toBeUndefined();
    expect(model.state.waitingMessages).toEqual([]); // stale bubble dropped
    model.stop();
  });

  it('cancelWaiting keeps the bubble on a transient (non-404) failure (#80)', async () => {
    const { connect } = recordingConnect();
    const cancelQueued = vi.fn().mockRejectedValue(new VerityApiError(500, 'server error'));
    const client = {
      sendTurn: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ resumable: true }),
      getHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
      getActivity: vi.fn().mockResolvedValue({
        busy: true,
        queued: [{ id: 'q1', text: 'still queued' }],
      }),
      cancelQueued,
    } as unknown as VerityClient;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    model.start();
    await flush();

    const text = await model.cancelWaiting('q1');
    // The turn is still queued server-side — surface nothing to edit AND keep the
    // bubble, so the operator can retry and never silently loses or double-sends it.
    expect(text).toBeUndefined();
    expect(model.state.waitingMessages).toEqual([{ id: 'q1', text: 'still queued' }]);
    model.stop();
  });
});

describe('SessionModel — decidePermission (#149)', () => {
  it('POSTs the operator decision and tracks the in-flight then cleared state', async () => {
    const { connect } = recordingConnect();
    const decidePermission = vi
      .fn()
      .mockResolvedValue({ sessionId: 's1', toolUseId: 'tu_1', decided: true });
    const updates: SessionModelState[] = [];
    const model = new SessionModel({
      client: {
        ...stubClient(),
        decidePermission,
      } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      onChange: (s) => updates.push(s),
    });

    await model.decidePermission('tu_1', { behavior: 'allow' });

    expect(decidePermission).toHaveBeenCalledWith('s1', 'tu_1', { behavior: 'allow' });
    // While in flight, decidingPermission named the tool; it clears when settled.
    expect(updates.some((s) => s.decidingPermission === 'tu_1')).toBe(true);
    expect(model.state.decidingPermission).toBeUndefined();
    expect(model.state.permissionError).toBeUndefined();
    model.stop();
  });

  // The card used to wait for a stream event to dismiss it. A turn that dies between
  // the prompt and its tool_call/tool_result never emits one, so the operator kept
  // seeing a live "approve/deny" card and every retry 404'd. Both server outcomes
  // that settle the prompt must dismiss it locally.
  it('dismisses the card once the server took the decision', async () => {
    const { connect, sockets } = recordingConnect();
    const decidePermission = vi
      .fn()
      .mockResolvedValue({ sessionId: 's1', toolUseId: 'tu_1', decided: true });
    const onPermissionSettled = vi.fn();
    const model = new SessionModel({
      client: { ...stubClient(), decidePermission } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      onPermissionSettled,
    });
    model.start();
    await flush();
    sockets[0]?.emitEvent(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(model.state.session.pendingPermission?.toolUseId).toBe('tu_1');

    await model.decidePermission('tu_1', { behavior: 'allow' });

    // No tool_call/tool_result/result follows — the card must still be gone.
    expect(model.state.session.pendingPermission).toBeUndefined();
    expect(onPermissionSettled).toHaveBeenCalledWith('tu_1', true);
    model.stop();
  });

  it('dismisses the card on a 404 (nothing pending server-side any more)', async () => {
    const { connect, sockets } = recordingConnect();
    const decidePermission = vi
      .fn()
      .mockRejectedValue(new VerityApiError(404, 'no pending permission tu_1'));
    const onPermissionSettled = vi.fn();
    const model = new SessionModel({
      client: { ...stubClient(), decidePermission } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      onPermissionSettled,
    });
    model.start();
    await flush();
    sockets[0]?.emitEvent(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));

    await model.decidePermission('tu_1', { behavior: 'allow' });

    expect(model.state.session.pendingPermission).toBeUndefined();
    expect(model.state.permissionError).toBeUndefined();
    expect(onPermissionSettled).toHaveBeenCalledWith('tu_1', false);
    model.stop();
  });

  // A transient failure is the one case the card must survive: it is still pending
  // server-side, so the operator has to be able to tap again.
  it('keeps the card actionable when the decision failed for another reason', async () => {
    const { connect, sockets } = recordingConnect();
    const decidePermission = vi
      .fn()
      .mockRejectedValue(new VerityApiError(500, 'boom on the server'));
    const model = new SessionModel({
      client: { ...stubClient(), decidePermission } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });
    model.start();
    await flush();
    sockets[0]?.emitEvent(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));

    await model.decidePermission('tu_1', { behavior: 'allow' });

    expect(model.state.session.pendingPermission?.toolUseId).toBe('tu_1');
    expect(model.state.permissionError).toContain('boom on the server');
    model.stop();
  });

  it('drops a double-tap while a decision is already in flight', async () => {
    const { connect } = recordingConnect();
    let resolveFirst!: () => void;
    const decidePermission = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve({ sessionId: 's1', toolUseId: 'tu_1', decided: true });
        }),
    );
    const model = new SessionModel({
      client: { ...stubClient(), decidePermission } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    const first = model.decidePermission('tu_1', { behavior: 'allow' });
    // A second call while the first is unresolved must be dropped (no second POST).
    await model.decidePermission('tu_1', { behavior: 'deny' });
    expect(decidePermission).toHaveBeenCalledTimes(1);
    resolveFirst();
    await first;
    model.stop();
  });

  it('swallows a 404 (the prompt already went stale) without an error', async () => {
    const { connect } = recordingConnect();
    const decidePermission = vi
      .fn()
      .mockRejectedValue(new VerityApiError(404, 'no pending permission tu_1'));
    const model = new SessionModel({
      client: { ...stubClient(), decidePermission } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    await model.decidePermission('tu_1', { behavior: 'allow' });
    expect(model.state.permissionError).toBeUndefined();
    expect(model.state.decidingPermission).toBeUndefined();
    model.stop();
  });

  it('warns when the request ran but its scoped grant was not saved', async () => {
    const { connect } = recordingConnect();
    const decidePermission = vi.fn().mockResolvedValue({
      sessionId: 's1',
      toolUseId: 'tu_1',
      decided: true,
      scopeSaved: false,
    });
    const model = new SessionModel({
      client: { ...stubClient(), decidePermission } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    await model.decidePermission('tu_1', { behavior: 'allow', scope: 'project' });
    expect(model.state.permissionError).toContain('Request allowed');
    expect(model.state.permissionError).toContain('will ask again');
    model.stop();
  });

  it('surfaces a non-404 failure as permissionError (api message vs generic)', async () => {
    const { connect } = recordingConnect();
    const decidePermission = vi.fn();
    const model = new SessionModel({
      client: { ...stubClient(), decidePermission } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
    });

    decidePermission.mockRejectedValueOnce(new VerityApiError(500, 'boom on the server'));
    await model.decidePermission('tu_1', { behavior: 'deny' });
    expect(model.state.permissionError).toContain('boom on the server');

    decidePermission.mockRejectedValueOnce(new Error('network down'));
    await model.decidePermission('tu_1', { behavior: 'deny' });
    expect(model.state.permissionError).toBe('failed to send the decision');
    model.stop();
  });
});

describe('SessionModel — a session that is still being created', () => {
  /** A `ready` gate the test settles by hand, standing in for the in-flight
   * `POST /sessions` the launch screen registers. */
  function gate(): { ready: Promise<void>; created: () => void; failed: (e: unknown) => void } {
    let created!: () => void;
    let failed!: (e: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      created = resolve;
      failed = reject;
    });
    return { ready, created, failed };
  }

  it('touches nothing until the session exists, then comes up normally', async () => {
    const { connect, sockets } = recordingConnect();
    const getHistory = vi.fn().mockResolvedValue({ events: [], hasMore: false });
    const getSession = vi.fn().mockResolvedValue({ resumable: true });
    const getActivity = vi.fn().mockResolvedValue({ busy: false, queued: [] });
    const { ready, created } = gate();
    const model = new SessionModel({
      client: { ...stubClient(), getHistory, getSession, getActivity } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      ready,
    });

    model.start();
    await flush();
    expect(model.state.locallyCreated).toBe(true);
    expect(model.state.loaded).toBe(false);
    // Every one of these would 404 against an id the server has not minted yet.
    expect(sockets).toHaveLength(0);
    expect(getHistory).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(getActivity).not.toHaveBeenCalled();

    created();
    await flush();
    expect(sockets[0]?.sinceSeq).toBe(0);
    expect(getSession).toHaveBeenCalled();
    expect(getActivity).toHaveBeenCalled();
    model.stop();
  });

  it('echoes a turn typed during the wait and dispatches it once the session lands', async () => {
    const { connect } = recordingConnect();
    const sendTurn = vi.fn().mockResolvedValue({ queued: false });
    const { ready, created } = gate();
    const model = new SessionModel({
      client: { ...stubClient(), sendTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      ready,
    });
    model.start();

    const sent = model.sendTurn('first thing');
    await flush();
    // The bubble is on screen for the whole wait — that is what makes it invisible.
    expect(model.state.pendingMessages.map((m) => m.text)).toEqual(['first thing']);
    expect(model.state.sending).toBe(true);
    expect(sendTurn).not.toHaveBeenCalled();

    created();
    await sent;
    expect(sendTurn).toHaveBeenCalledWith('s1', { prompt: 'first thing' });
    expect(model.state.sendError).toBeUndefined();
    model.stop();
  });

  it('reports a failed creation instead of waiting forever, and hands the text back', async () => {
    const { connect, sockets } = recordingConnect();
    const sendTurn = vi.fn();
    const { ready, failed } = gate();
    const model = new SessionModel({
      client: { ...stubClient(), sendTurn } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      ready,
    });
    model.start();

    const sent = model.sendTurn('first thing');
    failed(new Error('Provisioning heey-global/verity. Try again shortly.'));
    await sent;

    expect(model.state.streamError).toBe('Provisioning heey-global/verity. Try again shortly.');
    expect(model.state.sendError).toBe('Provisioning heey-global/verity. Try again shortly.');
    // Kept as a failed bubble, so tapping it puts the text back in the composer.
    expect(model.state.pendingMessages.map((m) => m.status)).toEqual(['failed']);
    expect(sendTurn).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    model.stop();
  });

  it('never opens a socket for a screen that was closed while its session was creating', async () => {
    const { connect, sockets } = recordingConnect();
    const getActivity = vi.fn().mockResolvedValue({ busy: false, queued: [] });
    const { ready, created } = gate();
    const model = new SessionModel({
      client: { ...stubClient(), getActivity } as unknown as VerityClient,
      sessionId: 's1',
      transport: connect,
      ready,
    });

    model.start();
    model.stop(); // the operator navigated away before the worktree was ready
    created();
    await flush();

    expect(sockets).toHaveLength(0);
    expect(getActivity).not.toHaveBeenCalled();
  });

  it('holds a backgrounded app off the network until it is resumed', async () => {
    const { connect, sockets } = recordingConnect();
    const client = stubClient();
    const { ready, created } = gate();
    const model = new SessionModel({
      client,
      sessionId: 's1',
      transport: connect,
      ready,
    });

    model.start();
    model.pause();
    created();
    await flush();
    expect(sockets).toHaveLength(0);

    model.resume();
    await flush();
    expect(sockets).toHaveLength(1);
    model.stop();
  });
});

it('keeps a session usable after a missing knowledge error', async () => {
  const { connect } = recordingConnect();
  const client = {
    ...stubClient(),
    getSession: vi.fn().mockResolvedValue({ resumable: true }),
    sendTurn: vi.fn().mockRejectedValue(new VerityApiError(404, 'Knowledge source not found')),
  } as unknown as VerityClient;
  const model = new SessionModel({ client, sessionId: 's1', transport: connect });
  model.start();
  try {
    await vi.waitFor(() => expect(model.state.resumable).toBe(true));
    expect(await model.sendTurn('Read the missing source')).toBe(false);
    expect(model.state.sendError).toBe('Knowledge source not found');
    expect(model.state.resumable).toBe(true);
  } finally {
    model.stop();
  }
});

describe('SessionModel — planning', () => {
  it.each(['implement', 'discard'] as const)(
    'keeps a successful %s decision when an earlier activity poll returns late',
    async (action) => {
      vi.useFakeTimers();
      const { connect } = recordingConnect();
      const client = stubClient();
      const active = {
        busy: false,
        queued: [],
        planning: 'active' as const,
        planningRevision: 7,
        planningPlan: 'Reviewed plan',
      };
      let resolvePoll!: (value: typeof active) => void;
      const delayed = new Promise<typeof active>((resolve) => {
        resolvePoll = resolve;
      });
      const getActivity = vi
        .fn()
        .mockResolvedValueOnce(active)
        .mockReturnValueOnce(delayed)
        .mockResolvedValue({ ...active, planningRevision: 8, planningPlan: 'Next round' });
      client.getActivity = getActivity;
      const decided = action === 'implement' ? 'implemented' : 'discarded';
      client.decidePlanning = vi.fn().mockResolvedValue({ planning: decided });
      const model = new SessionModel({ client, sessionId: 's1', transport: connect });
      try {
        model.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(model.state.planning).toBe('active');
        await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_POLL_MS);
        expect(getActivity).toHaveBeenCalledTimes(2);
        await model.decidePlanning(action, 7);
        expect(model.state.planning).toBe(decided);
        resolvePoll(active);
        await vi.advanceTimersByTimeAsync(0);
        expect(model.state.planning).toBe(decided);
        expect(model.state.planningRevision).toBe(7);
        await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_POLL_MS);
        expect(model.state.planning).toBe('active');
        expect(model.state.planningRevision).toBe(8);
      } finally {
        model.stop();
        vi.useRealTimers();
      }
    },
  );

  it('follows planning mode from the poll and ends it on the operator decision', async () => {
    const { connect } = recordingConnect();
    const client = stubClient();
    let planning: string | undefined = 'active';
    client.getActivity = vi.fn(async () => ({ busy: false, queued: [], planning })) as never;
    const decidePlanning = vi.fn(async () => {
      planning = 'implemented';
      return { planning: 'implemented' as const };
    });
    client.decidePlanning = decidePlanning;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    try {
      model.start();
      await flush();
      await flush();
      // An agent can start planning mid-turn; only the poll tells the app.
      expect(model.state.planning).toBe('active');

      await model.decidePlanning('implement', 7);
      expect(decidePlanning).toHaveBeenCalledWith('s1', 'implement', 7);
      expect(model.state.planning).toBe('implemented');
      expect(model.state.planningError).toBeUndefined();
    } finally {
      model.stop();
    }
  });

  it('refreshes the changed plan after a stale approval and preserves the review notice', async () => {
    const { connect } = recordingConnect();
    const client = stubClient();
    let revision = 2;
    client.getActivity = vi.fn(async () => ({
      busy: false,
      queued: [],
      planning: 'active',
      planningRevision: revision,
      planningPlan: `Plan ${String(revision)}`,
    })) as never;
    const decidePlanning = vi.fn(async () => {
      revision = 3;
      throw new VerityApiError(409, 'plan changed', { code: 'stalePlan' });
    });
    client.decidePlanning = decidePlanning;
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    try {
      model.start();
      await flush();
      await flush();
      expect(model.state.planningPlan).toBe('Plan 2');
      await model.decidePlanning('implement', 2);
      await flush();
      expect(decidePlanning).toHaveBeenCalledWith('s1', 'implement', 2);
      expect(model.state.planningRevision).toBe(3);
      expect(model.state.planningPlan).toBe('Plan 3');
      expect(model.state.planningError).toBe('The plan was updated. Please review it again.');
    } finally {
      model.stop();
    }
  });

  it('explains a decision that lost to another one', async () => {
    const { connect } = recordingConnect();
    const client = stubClient();
    client.decidePlanning = vi.fn(async () => {
      throw new VerityApiError(409, 'this session is not in planning mode');
    });
    const model = new SessionModel({ client, sessionId: 's1', transport: connect });
    try {
      model.start();
      await model.decidePlanning('discard');
      expect(model.state.planningError).toBe('Planning already ended.');
      expect(model.state.decidingPlanning).toBe(false);
    } finally {
      model.stop();
    }
  });
});

it('loads activity on demand without a recurring timer in live mode', async () => {
  const client = stubClient();
  const getActivity = vi.spyOn(client, 'getActivity');
  const { connect } = recordingConnect();
  const interval = vi.spyOn(globalThis, 'setInterval');
  const model = new SessionModel({ client, sessionId: 's', transport: connect, activityPollMs: 0 });
  try {
    model.start();
    await flush();
    expect(getActivity).toHaveBeenCalledTimes(1);
    expect(interval).not.toHaveBeenCalled();
    model.refreshActivity();
    await flush();
    expect(getActivity).toHaveBeenCalledTimes(2);
  } finally {
    model.stop();
    interval.mockRestore();
  }
});

it('passes only the captured Allow timing context and marks model completion', async () => {
  const client = stubClient();
  const decidePermission = vi
    .fn()
    .mockResolvedValue({ sessionId: 'timed-allow', toolUseId: 'private-use', decided: true });
  client.decidePermission = decidePermission;
  const model = new SessionModel({
    client,
    sessionId: 'timed-allow',
    transport: new FakeTransport(),
  });
  const trace = beginSessionSwitch('timed-allow', 'permission');
  await model.decidePermission('private-use', { behavior: 'allow' });
  expect(decidePermission).toHaveBeenCalledWith(
    'timed-allow',
    'private-use',
    { behavior: 'allow' },
    { trace },
  );
  expect(trace.phases.map((p) => p.phase)).toEqual(['allow-model-handler', 'allow-model-response']);
  expect(JSON.stringify(trace.phases)).not.toContain('private-use');
  model.stop();
});

it('records an Allow failure without exporting the error text', async () => {
  const client = stubClient();
  client.decidePermission = vi.fn().mockRejectedValue(new Error('private-secret-error'));
  const model = new SessionModel({
    client,
    sessionId: 'failed-allow',
    transport: new FakeTransport(),
  });
  const trace = beginSessionSwitch('failed-allow', 'permission');
  await model.decidePermission('private-use', { behavior: 'allow' });
  expect(trace.phases.map((p) => p.phase)).toEqual(['allow-model-handler', 'allow-model-error']);
  expect(JSON.stringify(trace.phases)).not.toContain('private-secret-error');
  model.stop();
});
