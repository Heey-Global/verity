/**
 * Stream bookkeeping shared by both ends of the tunnel.
 *
 * A stream has two directions that open and close independently. Each side owns
 * the sequence numbers it sends and verifies the ones it receives, so a dropped
 * or replayed frame is caught here rather than surfacing as a silently corrupt
 * response body.
 *
 * The registry is deliberately free of I/O: it decides, callers act. That keeps
 * the ordering rules testable without sockets, and lets the edge and the
 * connector share one implementation instead of two that drift.
 */

import type { StreamChannel, StreamResetCode } from './framing.js';

type DirectionState = 'idle' | 'open' | 'ended';

interface Direction {
  state: DirectionState;
  /** Next sequence number to send, or the next one expected to arrive. */
  seq: number;
  bytes: number;
  /** Whether `maxBodyBytes` applies cumulatively to this direction — true only
   * for the request direction of an `http` stream. */
  bounded: boolean;
}

export interface StreamRecord<TContext> {
  streamId: string;
  channel: StreamChannel;
  inbound: Direction;
  outbound: Direction;
  context: TContext;
}

export type StreamResult =
  | { ok: true; closed: boolean }
  | { ok: false; code: Extract<StreamResetCode, 'protocol_error' | 'body_limit'> };

const OK: StreamResult = { ok: true, closed: false };
const CLOSED: StreamResult = { ok: true, closed: true };
const PROTOCOL_ERROR: StreamResult = { ok: false, code: 'protocol_error' };
const BODY_LIMIT: StreamResult = { ok: false, code: 'body_limit' };

function direction(): Direction {
  return { state: 'idle', seq: 0, bytes: 0, bounded: false };
}

export interface StreamRegistryOptions {
  /**
   * Cumulative bytes allowed for the **request** body of an `http` stream — the
   * one direction a hop has to take in before it can act on it.
   *
   * It is deliberately not applied to the response direction: a response is
   * relayed frame by frame and never accumulated, so the byte total says
   * nothing about memory, and enforcing it there would kill every long-lived
   * response — an event stream, a large asset — the moment it grew past one
   * body's worth. Nor to `ws`, where a socket may legitimately carry far more
   * than one body over its lifetime. In both cases the per-frame bound in
   * `validStreamFrame` remains the limit.
   */
  maxBodyBytes: number;
}

export class StreamRegistry<TContext> {
  private readonly streams = new Map<string, StreamRecord<TContext>>();

  constructor(private readonly options: StreamRegistryOptions) {}

  get size(): number {
    return this.streams.size;
  }

  get(streamId: string): StreamRecord<TContext> | undefined {
    return this.streams.get(streamId);
  }

  records(): IterableIterator<StreamRecord<TContext>> {
    return this.streams.values();
  }

  /** Streams whose response head has not arrived yet. These are the ones still
   * bounded by the request timeout, and the ones counted as in-flight requests
   * rather than as established streams. */
  awaitingHead(): StreamRecord<TContext>[] {
    return [...this.streams.values()].filter(
      (record) => record.channel === 'http' && record.inbound.state === 'idle',
    );
  }

  /**
   * Registers a stream this side is opening. The reply direction stays idle
   * until the peer opens it in turn: on `http` with the status line, on `ws`
   * with the target's acceptance. Seeding it here instead would let a hop start
   * relaying to an endpoint that has not agreed to anything yet.
   */
  openOutbound(streamId: string, channel: StreamChannel, context: TContext): StreamResult {
    const existing = this.streams.get(streamId);
    if (existing) {
      if (existing.channel !== channel || existing.outbound.state !== 'idle') return PROTOCOL_ERROR;
      existing.outbound.state = 'open';
      return OK;
    }
    const record: StreamRecord<TContext> = {
      streamId,
      channel,
      inbound: direction(),
      outbound: direction(),
      context,
    };
    record.outbound.state = 'open';
    if (channel === 'http') record.outbound.bounded = true;
    this.streams.set(streamId, record);
    return OK;
  }

  /**
   * Applies a peer's `stream.open`. This is either the opening of a new stream
   * or the peer opening the reply direction of one this side started — a
   * response head, or a `ws` acceptance — which is why an existing record is not
   * by itself a protocol error.
   */
  acceptOpen(streamId: string, channel: StreamChannel, context: TContext): StreamResult {
    const existing = this.streams.get(streamId);
    if (existing) {
      if (existing.channel !== channel || existing.inbound.state !== 'idle') return PROTOCOL_ERROR;
      existing.inbound.state = 'open';
      return OK;
    }
    const record: StreamRecord<TContext> = {
      streamId,
      channel,
      inbound: direction(),
      outbound: direction(),
      context,
    };
    record.inbound.state = 'open';
    if (channel === 'http') record.inbound.bounded = true;
    this.streams.set(streamId, record);
    return OK;
  }

  /**
   * Applies a peer's `stream.data`. Rejects a gap or a repeat outright instead
   * of buffering: the transport underneath is an ordered, reliable WebSocket, so
   * an out-of-order sequence number means the peer is broken or hostile, not
   * that a frame is merely late.
   */
  acceptData(streamId: string, seq: number, byteLength: number): StreamResult {
    const record = this.streams.get(streamId);
    if (!record || record.inbound.state !== 'open') return PROTOCOL_ERROR;
    if (seq !== record.inbound.seq) return PROTOCOL_ERROR;
    const bytes = record.inbound.bytes + byteLength;
    if (record.inbound.bounded && bytes > this.options.maxBodyBytes) return BODY_LIMIT;
    record.inbound.seq += 1;
    record.inbound.bytes = bytes;
    return OK;
  }

  /** Applies a peer's `stream.end`, half-closing the receiving direction. */
  acceptEnd(streamId: string): StreamResult {
    const record = this.streams.get(streamId);
    if (!record || record.inbound.state !== 'open') return PROTOCOL_ERROR;
    record.inbound.state = 'ended';
    return this.settle(record);
  }

  /** Sequence number for the next frame this side sends, consuming it. */
  nextOutboundSeq(streamId: string): number | undefined {
    const record = this.streams.get(streamId);
    if (!record || record.outbound.state !== 'open') return undefined;
    const seq = record.outbound.seq;
    record.outbound.seq += 1;
    return seq;
  }

  /** Half-closes the sending direction after this side's `stream.end`. */
  endOutbound(streamId: string): StreamResult {
    const record = this.streams.get(streamId);
    if (!record || record.outbound.state !== 'open') return PROTOCOL_ERROR;
    record.outbound.state = 'ended';
    return this.settle(record);
  }

  /** Drops a stream outright, as `stream.reset` does in either direction. */
  reset(streamId: string): StreamRecord<TContext> | undefined {
    const record = this.streams.get(streamId);
    this.streams.delete(streamId);
    return record;
  }

  /**
   * Empties the registry and hands back every live stream so the caller can
   * terminate them. Used when a share expires or is revoked: the connection is
   * gone, so nothing would ever complete these.
   */
  drain(): StreamRecord<TContext>[] {
    const records = [...this.streams.values()];
    this.streams.clear();
    return records;
  }

  private settle(record: StreamRecord<TContext>): StreamResult {
    if (record.inbound.state !== 'ended' || record.outbound.state !== 'ended') return OK;
    this.streams.delete(record.streamId);
    return CLOSED;
  }
}
