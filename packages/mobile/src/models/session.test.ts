import type { AgentEvent } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';
import { VerityApiError, type VerityClient } from '../api.js';
import type { StreamSocket } from '../stream.js';
import { SessionModel, type SessionModelState } from './session.js';

type Listener = (event: { data: unknown }) => void;

class FakeSocket implements StreamSocket {
  closed = false;
  private msg: Listener[] = [];
  private cls: Listener[] = [];
  private err: Listener[] = [];
  constructor(readonly url: string) {}
  addEventListener(type: 'message' | 'close' | 'error', listener: Listener): void {
    if (type === 'message') this.msg.push(listener);
    else if (type === 'close') this.cls.push(listener);
    else this.err.push(listener);
  }
  close(): void {
    this.closed = true;
  }
  emitEvent(seq: number, event: AgentEvent): void {
    this.emitRaw(JSON.stringify({ k: 'event', seq, event }));
  }
  emitRaw(data: string): void {
    for (const l of this.msg) l({ data });
  }
  emitClose(): void {
    for (const l of this.cls) l({ data: undefined });
  }
}

function recordingConnect(): { connect: (url: string) => FakeSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    connect: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    sockets,
  };
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
  it('streams events into the session state and notifies, at the right URL', async () => {
    const { connect, sockets } = recordingConnect();
    const updates: number[] = [];
    const model = new SessionModel({
      client: stubClient(),
      sessionId: 's1',
      baseUrl: 'http://host',
      connect,
      onChange: (s) => updates.push(s.session.messages.length),
    });
    model.start();
    await flush();
    expect(sockets[0]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=0');
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
    model.start();
    await flush();
    // Resumes from just before the tail's first event → the older backlog is skipped.
    expect(sockets[0]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=99');
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });

    model.start();
    await flush();

    expect(getHistory).toHaveBeenNthCalledWith(2, 's1', { beforeSeq: 100, limit: 150 });
    expect(sockets[0]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=49');
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });

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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });

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
      baseUrl: 'http://host',
      connect,
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

  it('surfaces a stream error and clears it on the next event', async () => {
    const { connect, sockets } = recordingConnect();
    const model = new SessionModel({
      client: stubClient(),
      sessionId: 's1',
      baseUrl: 'http://host',
      connect,
    });
    model.start();
    await flush();
    sockets[0]?.emitRaw(JSON.stringify({ k: 'error', message: 'failed to load backlog' }));
    expect(model.state.streamError).toBe('failed to load backlog');
    sockets[0]?.emitEvent(1, { t: 'text', delta: 'ok' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 })); // flush → clears the error
    expect(model.state.streamError).toBeUndefined();
  });

  it('threads scheduleReconnect through to the stream', async () => {
    const { connect, sockets } = recordingConnect();
    const schedule = vi.fn();
    const model = new SessionModel({
      client: stubClient(),
      sessionId: 's1',
      baseUrl: 'http://host',
      connect,
      scheduleReconnect: schedule,
    });
    model.start();
    await flush();
    sockets[0]?.emitClose(); // an unexpected close → the stream schedules a reconnect
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1_000);
  });

  it('exposes reconnect lifecycle in model state', async () => {
    const { connect, sockets } = recordingConnect();
    let retry = (): void => undefined;
    const model = new SessionModel({
      client: stubClient(),
      sessionId: 's1',
      baseUrl: 'http://host',
      connect,
      scheduleReconnect: (next) => {
        retry = next;
      },
    });
    model.start();
    await flush();
    expect(model.state.connectionState).toBe('connecting');
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
    expect(model.state.connectionState).toBe('connected');
    sockets[0]?.emitClose();
    expect(model.state.connectionState).toBe('reconnecting');
    retry();
    sockets[1]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
    expect(model.state.connectionState).toBe('connected');
    model.stop();
    expect(model.state.connectionState).toBe('stopped');
  });

  it('stops the stream on stop()', async () => {
    const { connect, sockets } = recordingConnect();
    const model = new SessionModel({
      client: stubClient(),
      sessionId: 's1',
      baseUrl: 'http://host',
      connect,
    });
    model.start();
    await flush();
    model.stop();
    expect(sockets[0]?.closed).toBe(true);
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
    model.start();
    await flush();
    // Stream the tail so the reducer has a loaded head (oldestSeq = 100).
    sockets[0]?.emitEvent(100, { t: 'text', delta: 'tail' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 100 }));

    await model.loadOlderUntil(42);

    // One fetch sized to the whole span (100 − 42), not a fixed 150 page.
    expect(getHistory).toHaveBeenCalledWith('s1', { beforeSeq: 100, limit: 58 });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
    model.start();
    await flush();
    expect(model.state.busy).toBe(true);
  });
});

describe('SessionModel — working reconciliation', () => {
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
        baseUrl: 'http://host',
        connect,
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
      await vi.advanceTimersByTimeAsync(1500);
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
    });

    expect(model.state.resumable).toBeUndefined(); // unknown until the detail loads
    model.start();
    await vi.waitFor(() => {
      expect(model.state.resumable).toBe(false);
    });
    expect(getSession).toHaveBeenCalledWith('s1');
  });

  it('stays undefined (sendable) when the detail probe fails', async () => {
    const { connect } = recordingConnect();
    const getSession = vi.fn().mockRejectedValue(new Error('network'));
    const model = new SessionModel({
      client: { sendTurn: vi.fn(), getSession } as unknown as VerityClient,
      sessionId: 's1',
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
        events: [{ seq: 100, event: { t: 'text', delta: 'tail A' } }],
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });

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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });

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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });

    model.start();
    await flush();
    // Tail opened past the older backlog; emit the tail event so the stream has a cursor.
    expect(sockets[0]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=99');
    sockets[0]?.emitEvent(100, { t: 'text', delta: 'tail A' });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });

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
      getHistory.mockResolvedValueOnce({ events: [metadataHistoryEvent(seq)], hasMore: true });
    }
    const model = new SessionModel({
      client: { ...stubClient(), getHistory } as unknown as VerityClient,
      sessionId: 's1',
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });

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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
      const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
      model.start();
      await vi.advanceTimersByTimeAsync(0); // immediate first poll → still unnamed
      expect(model.state.name).toBeNull();
      await vi.advanceTimersByTimeAsync(1500); // next poll → auto-title landed server-side
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
      const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });

      model.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(model.state.session.rateLimit).toEqual({
        status: 'rejected',
        resetsAt: 101,
        window: 'five_hour',
        providerLabel: 'Codex',
      });

      vi.setSystemTime(new Date(102_000));
      await vi.advanceTimersByTimeAsync(1500);

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
      const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
      model.start();
      await vi.advanceTimersByTimeAsync(0); // immediate first poll
      expect(model.state.branch).toBe('main');
      await vi.advanceTimersByTimeAsync(1500); // next interval poll → external checkout
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
      const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
      model.start();
      await vi.advanceTimersByTimeAsync(0); // first poll starts, then hangs
      await vi.advanceTimersByTimeAsync(1500); // interval ticks → must be skipped
      await vi.advanceTimersByTimeAsync(1500); // and again
      expect(getActivity).toHaveBeenCalledTimes(1); // overlap guard held
      resolveFirst({ busy: false, queued: [] }); // the slow poll finally resolves
      await vi.advanceTimersByTimeAsync(1500); // next tick is allowed now
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
    const model = new SessionModel({ client, sessionId: 's1', baseUrl: 'http://host', connect });
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
    expect(sockets[0]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=0');
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
      baseUrl: 'http://host',
      connect,
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
