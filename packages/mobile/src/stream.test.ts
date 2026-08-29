import type { AgentEvent } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';
import { SessionStream, type StreamSocket } from './stream.js';

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
  emitError(): void {
    for (const l of this.err) l({ data: undefined });
  }
}

/** A connect factory that records every socket it opens. */
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

describe('SessionStream', () => {
  it('connects to the session stream URL (http→ws) starting at sinceSeq 0', () => {
    const { connect, sockets } = recordingConnect();
    new SessionStream({ baseUrl: 'http://host:3000/', sessionId: 's1', connect }).start();
    expect(sockets[0]?.url).toBe('ws://host:3000/sessions/s1/stream?sinceSeq=0');
  });

  it('appends the bearer token as an access_token query param (audit C1)', () => {
    const { connect, sockets } = recordingConnect();
    new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      getToken: () => 'tok-xyz',
    }).start();
    expect(sockets[0]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=0&access_token=tok-xyz');
  });

  it('omits access_token when the token provider returns null', () => {
    const { connect, sockets } = recordingConnect();
    new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      getToken: () => null,
    }).start();
    expect(sockets[0]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=0');
  });

  it('decodes event frames into the reducer and tracks the seq', () => {
    const { connect, sockets } = recordingConnect();
    const updates: number[] = [];
    const stream = new SessionStream({
      baseUrl: 'https://host',
      sessionId: 's1',
      connect,
      onUpdate: (state) => updates.push(state.messages.length),
    });
    stream.start();
    const s = sockets[0];
    // Backlog events apply to the reducer but are batched — no onUpdate until the
    // `caught_up` watermark, so the screen renders the history in one pass (no
    // per-event re-render / scroll-thrash on open).
    s?.emitEvent(1, { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    s?.emitEvent(2, { t: 'text', delta: 'hi ' });
    s?.emitEvent(3, { t: 'text', delta: 'there' });
    expect(updates.length).toBe(0); // suppressed during the backlog
    s?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 3 }));
    expect(stream.state.sessionId).toBe('s1');
    expect(stream.state.messages.map((msg) => (msg.kind === 'agent-text' ? msg.text : ''))).toEqual(
      ['hi there'],
    );
    expect(updates.length).toBe(1); // one batched update at caught_up
  });

  it('prepends older history, rebuilding the transcript across the page boundary', () => {
    const { connect, sockets } = recordingConnect();
    const updates: number[] = [];
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      onUpdate: (state) => updates.push(state.messages.length),
    });
    stream.start();
    const s = sockets[0];
    // Tail: a tool_result whose matching tool_call lives in the OLDER page.
    s?.emitEvent(10, { t: 'session', id: 's1', model: 'm', worktree: '/wt' });
    s?.emitEvent(11, { t: 'tool_result', id: 'tool1', output: 'done', isError: false });
    s?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 11 }));
    expect(stream.oldestSeq).toBe(10);
    const afterTail = updates.length;

    stream.prependHistory([
      { seq: 8, event: { t: 'prompt', text: 'do it' } },
      { seq: 9, event: { t: 'tool_call', id: 'tool1', name: 'Bash', input: { command: 'ls' } } },
    ]);

    expect(stream.oldestSeq).toBe(8); // cursor moved back for the next page
    expect(updates.length).toBe(afterTail + 1); // emitted a fresh snapshot
    // The older tool_call pairs with the tail's tool_result → one completed tool,
    // and the older prompt is ordered first.
    expect(stream.state.messages[0]).toMatchObject({ kind: 'user-text', text: 'do it' });
    expect(stream.state.messages.filter((m) => m.kind === 'tool-call')).toHaveLength(1);
  });

  it('keeps a resolved permission dismissed across a reducer rebuild', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ baseUrl: 'http://host', sessionId: 's1', connect });
    stream.start();
    const s = sockets[0];
    s?.emitEvent(10, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    s?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 10 }));
    expect(stream.state.pendingPermission?.toolUseId).toBe('tu_1');

    stream.resolvePermission('tu_1');
    expect(stream.state.pendingPermission).toBeUndefined();
    // The answered frame is retained: it carries the scroll-up cursor, so dismissing
    // a card must not strand backward pagination.
    expect(stream.oldestSeq).toBe(10);

    // Scroll-up rebuilds the reducer over the retained frames — and an older page may
    // even carry the same prompt again. Neither may bring the answered card back.
    stream.prependHistory([
      { seq: 8, event: { t: 'prompt', text: 'do it' } },
      {
        seq: 9,
        event: { t: 'permission', id: 'tu_1', tool: 'Bash', input: {}, riskClass: 'ask' },
      },
    ]);
    expect(stream.state.pendingPermission).toBeUndefined();
  });

  it('ignores a prepend that is not strictly older than the loaded head', () => {
    const { connect, sockets } = recordingConnect();
    const updates: number[] = [];
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      onUpdate: (state) => updates.push(state.messages.length),
    });
    stream.start();
    sockets[0]?.emitEvent(5, { t: 'text', delta: 'tail' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 5 }));
    const before = updates.length;
    stream.prependHistory([{ seq: 5, event: { t: 'text', delta: 'dup' } }]); // not older → no-op
    expect(stream.oldestSeq).toBe(5);
    expect(updates.length).toBe(before);
  });

  it('forwards a caught_up watermark as an update without advancing the cursor', () => {
    const { connect, sockets } = recordingConnect();
    let scheduled = (): void => undefined;
    const updates: number[] = [];
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      onUpdate: () => updates.push(1),
      scheduleReconnect: (r) => {
        scheduled = r;
      },
    });
    stream.start();
    sockets[0]?.emitEvent(1, { t: 'text', delta: 'hi' }); // backlog — batched (no update)
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(updates.length).toBe(1); // caught_up flushes the batched backlog once

    // caught_up does not advance lastSeq → a reconnect resumes from the event seq
    sockets[0]?.emitClose();
    scheduled();
    expect(sockets[1]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=1');
  });

  it('uses wss:// for an https base url', () => {
    const { connect, sockets } = recordingConnect();
    new SessionStream({ baseUrl: 'https://host', sessionId: 's1', connect }).start();
    expect(sockets[0]?.url).toBe('wss://host/sessions/s1/stream?sinceSeq=0');
  });

  it('surfaces a server error frame and an undecodable message via onError', () => {
    const { connect, sockets } = recordingConnect();
    const errors: string[] = [];
    new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      onError: (m) => errors.push(m),
    }).start();
    sockets[0]?.emitRaw(JSON.stringify({ k: 'error', message: 'failed to load backlog' }));
    sockets[0]?.emitRaw('{not json');
    expect(errors[0]).toBe('failed to load backlog');
    expect(errors[1]).toContain('undecodable');
  });

  it('reconnects on close, resuming from the last seq', () => {
    const { connect, sockets } = recordingConnect();
    let retry = (): void => undefined;
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      scheduleReconnect: (r) => {
        retry = r;
      },
    });
    stream.start();
    sockets[0]?.emitEvent(1, { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    sockets[0]?.emitEvent(2, { t: 'text', delta: 'first' });
    sockets[0]?.emitEvent(3, { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: {} }); // boundary
    sockets[0]?.emitClose(); // connection drops at seq 3

    retry(); // the scheduled reconnect fires
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=3'); // resume cursor = lastSeq

    // the reducer persists across reconnect: the 'first' block survives and the
    // post-reconnect text is a new, distinct message (no reset, no duplication).
    sockets[1]?.emitEvent(4, { t: 'text', delta: 'second' });
    const texts = stream.state.messages.filter((m) => m.kind === 'agent-text');
    expect(texts.map((m) => (m.kind === 'agent-text' ? m.text : ''))).toEqual(['first', 'second']);
  });

  it('pauses in background and resumes from the last seq without a stale reconnect', () => {
    const { connect, sockets } = recordingConnect();
    let retry = (): void => undefined;
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      scheduleReconnect: (next) => {
        retry = next;
      },
    });
    stream.start();
    sockets[0]?.emitEvent(4, { t: 'text', delta: 'before background' });
    sockets[0]?.emitClose();

    stream.pause();
    retry();
    expect(sockets).toHaveLength(1); // scheduled reconnect was invalidated by pause

    stream.resume();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=4');

    // A late close from the old socket cannot clobber the resumed one.
    sockets[0]?.emitClose();
    expect(sockets).toHaveLength(2);

    // Nor can a buffered frame from that retired socket regress the cursor.
    sockets[0]?.emitEvent(2, { t: 'text', delta: 'stale' });
    sockets[1]?.emitEvent(5, { t: 'text', delta: 'current' });
    sockets[1]?.emitClose();
    retry();
    expect(sockets[2]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=5');
    const texts = stream.state.messages.filter((message) => message.kind === 'agent-text');
    expect(texts.map((message) => (message.kind === 'agent-text' ? message.text : ''))).toEqual([
      'before backgroundcurrent',
    ]);
  });

  it('actively closes an open socket when paused', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ baseUrl: 'http://host', sessionId: 's1', connect });
    stream.start();
    stream.pause();
    expect(sockets[0]?.closed).toBe(true);

    stream.resume();
    expect(sockets[1]?.url).toBe('ws://host/sessions/s1/stream?sinceSeq=0');
  });

  it('surfaces a socket error event via onError', () => {
    const { connect, sockets } = recordingConnect();
    const errors: string[] = [];
    new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      onError: (m) => errors.push(m),
    }).start();
    sockets[0]?.emitError();
    expect(errors).toEqual(['stream connection error']);
  });

  it('falls back to a setTimeout reconnect when no scheduler is injected', () => {
    vi.useFakeTimers();
    try {
      const { connect, sockets } = recordingConnect();
      const stream = new SessionStream({ baseUrl: 'http://host', sessionId: 's1', connect });
      stream.start();
      sockets[0]?.emitClose();
      expect(sockets).toHaveLength(1); // not reconnected yet
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2); // reconnected via the default timer
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off repeated failed reconnects and caps the delay', () => {
    const { connect, sockets } = recordingConnect();
    const scheduled: { retry: () => void; delayMs: number }[] = [];
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      scheduleReconnect: (retry, delayMs) => scheduled.push({ retry, delayMs }),
    });
    stream.start();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      sockets.at(-1)?.emitClose();
      scheduled.at(-1)?.retry();
    }

    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    stream.stop();
  });

  it('resets reconnect backoff only after the replacement stream catches up', () => {
    const { connect, sockets } = recordingConnect();
    const delays: number[] = [];
    let retry = (): void => undefined;
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      scheduleReconnect: (next, delayMs) => {
        retry = next;
        delays.push(delayMs);
      },
    });
    stream.start();
    sockets[0]?.emitClose();
    retry();
    sockets[1]?.emitClose();
    retry();
    sockets[2]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
    sockets[2]?.emitClose();
    expect(delays).toEqual([1_000, 2_000, 1_000]);
    stream.stop();
  });

  it('reports reconnect lifecycle and reads a rotated token on every attempt', () => {
    const { connect, sockets } = recordingConnect();
    const states: string[] = [];
    let token = 'old';
    let retry = (): void => undefined;
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      getToken: () => token,
      onConnectionStateChange: (state) => states.push(state),
      scheduleReconnect: (next) => {
        retry = next;
      },
    });
    stream.start();
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
    sockets[0]?.emitClose();
    token = 'rotated';
    retry();
    sockets[1]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
    stream.stop();

    expect(sockets[0]?.url).toContain('access_token=old');
    expect(sockets[1]?.url).toContain('access_token=rotated');
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected', 'stopped']);
  });

  it('start() after stop() is a no-op', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ baseUrl: 'http://host', sessionId: 's1', connect });
    stream.stop();
    stream.start();
    expect(sockets).toHaveLength(0);
  });

  it('ignores late messages and errors after stop()', () => {
    const { connect, sockets } = recordingConnect();
    const updates: number[] = [];
    const errors: string[] = [];
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      onUpdate: () => updates.push(1),
      onError: (m) => errors.push(m),
    });
    stream.start();
    stream.stop();
    // frames buffered on the now-abandoned socket must not push state/errors
    sockets[0]?.emitEvent(1, { t: 'text', delta: 'late' });
    sockets[0]?.emitError();
    expect(updates).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('start() twice does not open a second socket (call-once)', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ baseUrl: 'http://host', sessionId: 's1', connect });
    stream.start();
    stream.start();
    expect(sockets).toHaveLength(1);
    stream.stop();
  });

  it('does not reconnect after stop()', () => {
    const { connect, sockets } = recordingConnect();
    let retried = false;
    const stream = new SessionStream({
      baseUrl: 'http://host',
      sessionId: 's1',
      connect,
      scheduleReconnect: () => {
        retried = true;
      },
    });
    stream.start();
    stream.stop();
    expect(sockets[0]?.closed).toBe(true);
    sockets[0]?.emitClose(); // a close after stop must not schedule a reconnect
    expect(retried).toBe(false);
    expect(sockets).toHaveLength(1);
  });
});
