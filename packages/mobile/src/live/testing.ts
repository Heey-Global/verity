import type { AgentEvent, LiveEndedReason } from '@verity/events';
import type { LiveSessionHandle, LiveSessionSink, LiveSessionTransport } from './connection.js';

// Test doubles for code that streams sessions over the live connection. Not
// imported by the app.

/**
 * One subscription of the session on the fake live connection. Kept shaped like
 * the per-session socket these tests were written against: `emitEvent`,
 * `emitRaw` and `emitClose` drive the sink the way server frames and a dropped
 * connection would.
 */
export class FakeSubscription {
  closed = false;
  constructor(
    readonly sessionId: string,
    readonly sinceSeq: number,
    public view: boolean,
    private readonly sink: LiveSessionSink,
  ) {}
  emitEvent(seq: number, event: AgentEvent): void {
    if (!this.closed) this.sink.event({ seq, event });
  }
  emitRaw(data: string): void {
    if (this.closed) return;
    const frame = JSON.parse(data) as { k: string; seq?: number; reason?: LiveEndedReason };
    if (frame.k === 'caught_up') this.sink.caughtUp(frame.seq ?? 0);
    else if (frame.k === 'ended') this.sink.ended(frame.reason ?? 'error');
  }
  /** The connection dropped; {@link FakeTransport.reconnect} resubscribes. */
  emitClose(message?: string): void {
    this.sink.disconnected(message);
  }
}

interface FakeEntry {
  sessionId: string;
  sink: LiveSessionSink;
  view: boolean;
  current: FakeSubscription | undefined;
}

export class FakeTransport implements LiveSessionTransport {
  readonly sockets: FakeSubscription[] = [];
  private readonly open = new Set<FakeEntry>();
  subscribeSession(sessionId: string, sink: LiveSessionSink, view: boolean): LiveSessionHandle {
    const entry: FakeEntry = { sessionId, sink, view, current: undefined };
    this.open.add(entry);
    this.record(entry);
    return {
      setView: (next) => {
        entry.view = next;
        if (entry.current) entry.current.view = next;
      },
      close: () => {
        this.open.delete(entry);
        if (entry.current) entry.current.closed = true;
      },
    };
  }
  private record(entry: FakeEntry): void {
    entry.current = new FakeSubscription(
      entry.sessionId,
      entry.sink.cursor(),
      entry.view,
      entry.sink,
    );
    this.sockets.push(entry.current);
  }
  /** The connection is back: every open subscription resumes from its cursor. */
  reconnect(): void {
    for (const entry of this.open) this.record(entry);
  }
}
