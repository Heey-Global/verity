import { beginSessionSwitch } from './sessionSwitchTiming.js';
import { describe, expect, it } from 'vitest';
import { FakeTransport } from './live/testing.js';
import { SessionStream } from './stream.js';

function recordingConnect(): { connect: FakeTransport; sockets: FakeTransport['sockets'] } {
  const connect = new FakeTransport();
  return { connect, sockets: connect.sockets };
}

describe('SessionStream', () => {
  it('decodes event frames into the reducer and tracks the seq', () => {
    const { connect, sockets } = recordingConnect();
    const updates: number[] = [];
    const stream = new SessionStream({
      sessionId: 's1',
      transport: connect,
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

  it.each([true, false])(
    'prepends older history across the page boundary (notify=%s)',
    (notify) => {
      const { connect, sockets } = recordingConnect();
      const updates: number[] = [];
      const stream = new SessionStream({
        sessionId: 's1',
        transport: connect,
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

      stream.prependHistory(
        [
          { seq: 8, event: { t: 'prompt', text: 'do it' } },
          {
            seq: 9,
            event: { t: 'tool_call', id: 'tool1', name: 'Bash', input: { command: 'ls' } },
          },
        ],
        { notify },
      );

      expect(stream.oldestSeq).toBe(8); // cursor moved back for the next page
      expect(updates.length).toBe(afterTail + (notify ? 1 : 0));
      // The older tool_call pairs with the tail's tool_result → one completed tool,
      // and the older prompt is ordered first.
      expect(stream.state.messages[0]).toMatchObject({ kind: 'user-text', text: 'do it' });
      expect(stream.state.messages.filter((m) => m.kind === 'tool-call')).toMatchObject([
        { tool: { state: 'completed', result: 'done' } },
      ]);
    },
  );

  it('preserves unchanged replay snapshots and invalidates later live text and tool updates', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
    stream.start();
    const socket = sockets[0];
    socket?.emitEvent(10, { t: 'text', delta: 'closed' });
    socket?.emitEvent(11, { t: 'tool_call', id: 't1', name: 'Bash', input: {} });
    socket?.emitEvent(12, { t: 'text', delta: 'live' });
    socket?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 12 }));
    const before = stream.state.messages;
    stream.prependHistory([{ seq: 9, event: { t: 'prompt', text: 'older' } }]);
    const replayed = stream.state.messages;
    // Replaying unchanged rows must not invalidate every memoized transcript row.
    expect(replayed.slice(1)).toEqual(before);
    before.forEach((message, index) => expect(replayed[index + 1]).toBe(message));
    socket?.emitEvent(13, { t: 'text', delta: ' update' });
    expect(stream.state.messages[3]).not.toBe(before[2]);
    expect(stream.state.messages[3]).toMatchObject({ text: 'live update' });
    expect(before[2]).toMatchObject({ text: 'live' });
    socket?.emitEvent(14, { t: 'tool_result', id: 't1', output: 'done', isError: false });
    expect(stream.state.messages[2]).not.toBe(before[1]);
    expect(stream.state.messages[2]).toMatchObject({
      tool: { state: 'completed', result: 'done' },
    });
    expect(before[1]).toMatchObject({ tool: { state: 'running' } });
    expect(stream.state.messages[1]).toBe(before[0]);
  });

  it('publishes merged text freshly when an older page continues the loaded head', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
    stream.start();
    sockets[0]?.emitEvent(10, { t: 'text', delta: 'tail' });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 10 }));
    const before = stream.state.messages[0];
    stream.prependHistory([{ seq: 9, event: { t: 'text', delta: 'head ' } }]);
    const merged = stream.state.messages[0];
    expect(merged).not.toBe(before);
    expect(merged).toMatchObject({ id: 'text-9', text: 'head tail' });
    expect(before).toMatchObject({ id: 'text-10', text: 'tail' });
    sockets[0]?.emitEvent(11, { t: 'text', delta: ' live' });
    expect(stream.state.messages[0]).toMatchObject({ text: 'head tail live' });
    expect(merged).toMatchObject({ text: 'head tail' });
  });

  it('keeps a resolved permission dismissed across a reducer rebuild', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
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

    stream.reconcilePendingPermissions([]);
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
      sessionId: 's1',
      transport: connect,
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

  it('does not let an older pending snapshot retire a newer streamed permission', () => {
    const { connect, sockets } = recordingConnect();
    const updates: Array<string | undefined> = [];
    const stream = new SessionStream({
      sessionId: 's1',
      transport: connect,
      onUpdate: (state) => updates.push(state.pendingPermission?.toolUseId),
    });
    stream.start();
    sockets[0]?.emitEvent(11, {
      t: 'permission',
      id: 'new-permission',
      tool: 'Bash',
      input: {},
      riskClass: 'ask',
    });
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 11 }));

    stream.reconcilePendingPermissions([], 10);

    expect(stream.state.pendingPermission?.toolUseId).toBe('new-permission');
    const updatesBeforeSettlement = updates.length;
    stream.reconcilePendingPermissions([], 11);
    expect(stream.state.pendingPermission).toBeUndefined();
    expect(updates).toHaveLength(updatesBeforeSettlement + 1);
    expect(updates.at(-1)).toBeUndefined();
  });

  it('ignores duplicate and out-of-order live sequence frames', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
    stream.start();
    sockets[0]?.emitEvent(2, { t: 'text', delta: 'new' });
    sockets[0]?.emitEvent(2, { t: 'text', delta: 'duplicate' });
    sockets[0]?.emitEvent(1, { t: 'text', delta: 'old' });
    expect(stream.newestSeq).toBe(2);
    expect(stream.state.messages).toHaveLength(1);
  });

  it('forwards a caught_up watermark as an update without advancing the cursor', () => {
    const { connect, sockets } = recordingConnect();
    const updates: number[] = [];
    const stream = new SessionStream({
      sessionId: 's1',
      transport: connect,
      onUpdate: () => updates.push(1),
    });
    stream.start();
    sockets[0]?.emitEvent(1, { t: 'text', delta: 'hi' }); // backlog — batched (no update)
    sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 1 }));
    expect(updates.length).toBe(1); // caught_up flushes the batched backlog once

    // caught_up does not advance the cursor → a reconnect resumes from the event seq
    sockets[0]?.emitClose();
    connect.reconnect();
    expect(sockets[1]?.sinceSeq).toBe(1);
  });
  it('reports a session the server will not stream, and stops', () => {
    const { connect, sockets } = recordingConnect();
    const errors: string[] = [];
    const states: string[] = [];
    new SessionStream({
      sessionId: 's1',
      transport: connect,
      onError: (m) => errors.push(m),
      onConnectionStateChange: (state) => states.push(state),
    }).start();
    sockets[0]?.emitRaw(JSON.stringify({ k: 'ended', reason: 'not_found' }));
    expect(errors).toEqual(['This session no longer exists.']);
    expect(states.at(-1)).toBe('stopped');
  });

  it('surfaces why the connection dropped', () => {
    const { connect, sockets } = recordingConnect();
    const errors: string[] = [];
    new SessionStream({
      sessionId: 's1',
      transport: connect,
      onError: (m) => errors.push(m),
    }).start();
    sockets[0]?.emitClose('Core is unreachable.');
    expect(errors).toEqual(['Core is unreachable.']);
  });
  it('resumes from the last seq after the connection comes back', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
    stream.start();
    sockets[0]?.emitEvent(1, { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    sockets[0]?.emitEvent(2, { t: 'text', delta: 'first' });
    sockets[0]?.emitEvent(3, { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: {} }); // boundary
    sockets[0]?.emitClose(); // connection drops at seq 3

    connect.reconnect();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.sinceSeq).toBe(3); // resume cursor = lastSeq

    // the reducer persists across reconnect: the 'first' block survives and the
    // post-reconnect text is a new, distinct message (no reset, no duplication).
    sockets[1]?.emitEvent(4, { t: 'text', delta: 'second' });
    const texts = stream.state.messages.filter((m) => m.kind === 'agent-text');
    expect(texts.map((m) => (m.kind === 'agent-text' ? m.text : ''))).toEqual(['first', 'second']);
  });
  it('pauses in background and resumes from the last seq', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
    stream.start();
    sockets[0]?.emitEvent(4, { t: 'text', delta: 'before background' });

    stream.pause();
    expect(sockets[0]?.closed).toBe(true);
    connect.reconnect();
    expect(sockets).toHaveLength(1); // a paused stream is not resubscribed

    stream.resume();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.sinceSeq).toBe(4);

    // A buffered frame from the retired subscription cannot regress the cursor.
    sockets[0]?.emitEvent(2, { t: 'text', delta: 'stale' });
    sockets[1]?.emitEvent(5, { t: 'text', delta: 'current' });
    const texts = stream.state.messages.filter((message) => message.kind === 'agent-text');
    expect(texts.map((message) => (message.kind === 'agent-text' ? message.text : ''))).toEqual([
      'before backgroundcurrent',
    ]);
  });
  it('leaves its subscription when paused', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
    stream.start();
    stream.pause();
    expect(sockets[0]?.closed).toBe(true);

    stream.resume();
    expect(sockets[1]?.sinceSeq).toBe(0);
  });
  it('start() after stop() is a no-op', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
    stream.stop();
    stream.start();
    expect(sockets).toHaveLength(0);
  });

  it('ignores late messages and errors after stop()', () => {
    const { connect, sockets } = recordingConnect();
    const updates: number[] = [];
    const errors: string[] = [];
    const stream = new SessionStream({
      sessionId: 's1',
      transport: connect,
      onUpdate: () => updates.push(1),
      onError: (m) => errors.push(m),
    });
    stream.start();
    stream.stop();
    // frames buffered on the now-abandoned socket must not push state/errors
    sockets[0]?.emitEvent(1, { t: 'text', delta: 'late' });
    sockets[0]?.emitClose('late failure');
    expect(updates).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('start() twice does not subscribe twice (call-once)', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
    stream.start();
    stream.start();
    expect(sockets).toHaveLength(1);
    stream.stop();
  });

  it('does not reconnect after stop()', () => {
    const { connect, sockets } = recordingConnect();
    const stream = new SessionStream({ sessionId: 's1', transport: connect });
    stream.start();
    stream.stop();
    expect(sockets[0]?.closed).toBe(true);
    connect.reconnect(); // a stopped stream is not resubscribed
    expect(sockets).toHaveLength(1);
  });
});

it('attributes replay timing to its original switch and ignores superseded callbacks', () => {
  const first = beginSessionSwitch('timed-replay');
  const { connect, sockets } = recordingConnect();
  const stream = new SessionStream({ sessionId: 'timed-replay', transport: connect });
  stream.start();
  sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
  expect(first.phases.map((p) => p.phase)).toEqual(['replay-subscribe', 'replay-caught-up']);
  beginSessionSwitch('other-replay');
  const returned = beginSessionSwitch('timed-replay');
  sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 0 }));
  expect(returned.phases).toEqual([]);
  stream.stop();
});
