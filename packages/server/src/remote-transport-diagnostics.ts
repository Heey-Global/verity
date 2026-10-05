import type { Socket } from 'node:net';
import type WebSocket from 'ws';

const TRACE_LIMIT = 16;
const PENDING_LIMIT = 16_384;

/** Transport acceptance is deliberately separate from delivery to the other endpoint. */
export class RemoteTransportDiagnostics {
  private rawMessages = 0;
  private rawBytes = 0;
  private lastRawAt: number | null = null;
  private enqueuedFrames = 0;
  private enqueuedBytes = 0;
  private completedFrames = 0;
  private completedBytes = 0;
  private errorFrames = 0;
  private errorBytes = 0;
  private maxPendingFrames = 0;
  private maxCallbackMs = 0;
  private pendingBytes = 0;
  private nextWrite = 0;
  private pending = new Map<number, { at: number; bytes: number }>();
  private trace: Record<string, unknown>[] = [];
  private pings = 0;
  private pongs = 0;
  private lastPongAt: number | null = null;
  private bufferedMax = 0;
  private lastEnqueueAt: number | null = null;
  private lastCallbackAt: number | null = null;

  constructor(private readonly sessionId: string) {}

  receive(bytes: number): void {
    this.rawMessages++;
    this.rawBytes += bytes;
    this.lastRawAt = Date.now();
  }

  frame(direction: 'in' | 'out', frame: Record<string, unknown>, writeId?: number): void {
    // Never copy arbitrary frame values: even malformed types can contain credentials.
    const type = ['stream.open', 'stream.data', 'stream.end', 'stream.reset', 'attached'].includes(
      String(frame.type),
    )
      ? frame.type
      : 'unknown';
    this.trace.push({
      ...(writeId === undefined ? {} : { writeId }),
      at: Date.now(),
      direction,
      type,
      ...(typeof frame.streamId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(frame.streamId)
        ? { streamId: frame.streamId }
        : {}),
      ...(Number.isSafeInteger(frame.seq) && (frame.seq as number) >= 0 ? { seq: frame.seq } : {}),
    });
    if (this.trace.length > TRACE_LIMIT) this.trace.shift();
  }

  enqueue(bytes: number): number | null {
    if (this.pending.size >= PENDING_LIMIT) return null;
    const id = this.nextWrite++;
    this.lastEnqueueAt = Date.now();
    this.pending.set(id, { at: Date.now(), bytes });
    this.maxPendingFrames = Math.max(this.maxPendingFrames, this.pending.size);
    this.enqueuedFrames++;
    this.enqueuedBytes += bytes;
    this.pendingBytes += bytes;
    return id;
  }

  complete(id: number, failed: boolean): void {
    const write = this.pending.get(id);
    if (!write) return;
    this.lastCallbackAt = Date.now();
    const entry = this.trace.find((item) => item.writeId === id);
    if (entry) {
      entry.callbackAt = this.lastCallbackAt;
      entry.callbackMs = this.lastCallbackAt - write.at;
      entry.outcome = failed ? 'error' : 'accepted';
      entry.encodedBytes = write.bytes;
    }
    this.pending.delete(id);
    this.pendingBytes -= write.bytes;
    this.maxCallbackMs = Math.max(this.maxCallbackMs, Date.now() - write.at);
    if (failed) {
      this.errorFrames++;
      this.errorBytes += write.bytes;
    } else {
      this.completedFrames++;
      this.completedBytes += write.bytes;
    }
  }

  heartbeat(kind: 'ping' | 'pong'): void {
    if (kind === 'ping') this.pings++;
    else {
      this.pongs++;
      this.lastPongAt = Date.now();
    }
  }

  observeBuffer(bytes: number): void {
    this.bufferedMax = Math.max(this.bufferedMax, bytes);
  }

  snapshot(ws: WebSocket | undefined): Record<string, unknown> {
    // ws exposes no public socket accessor. Missing fields are unknown, never zero.
    const socket = (ws as (WebSocket & { _socket?: Socket }) | undefined)?._socket;
    this.bufferedMax = Math.max(this.bufferedMax, ws?.bufferedAmount ?? 0);
    const oldest = this.pending.values().next().value;
    return {
      event: 'remote.transport',
      at: new Date().toISOString(),
      sessionId: this.sessionId,
      rawMessages: this.rawMessages,
      rawBytes: this.rawBytes,
      lastRawAt: this.lastRawAt,
      enqueuedFrames: this.enqueuedFrames,
      enqueuedBytes: this.enqueuedBytes,
      completedFrames: this.completedFrames,
      completedBytes: this.completedBytes,
      lastEnqueueAt: this.lastEnqueueAt,
      lastCallbackAt: this.lastCallbackAt,
      errorFrames: this.errorFrames,
      errorBytes: this.errorBytes,
      maxPendingFrames: this.maxPendingFrames,
      maxCallbackMs: this.maxCallbackMs,
      pendingFrames: this.pending.size,
      pendingBytes: this.pendingBytes,
      oldestPendingMs: oldest ? Date.now() - oldest.at : 0,
      wsState: ws?.readyState ?? null,
      bufferedBytes: ws?.bufferedAmount ?? null,
      bufferedMax: this.bufferedMax,
      pings: this.pings,
      pongs: this.pongs,
      lastPongAt: this.lastPongAt,
      socket: socket
        ? {
            bytesRead: socket.bytesRead,
            bytesWritten: socket.bytesWritten,
            writableLength: socket.writableLength,
            writableNeedDrain: socket.writableNeedDrain,
            destroyed: socket.destroyed,
            readable: socket.readable,
            writable: socket.writable,
            localAddress: socket.localAddress ?? null,
            localPort: socket.localPort ?? null,
            remoteAddress: socket.remoteAddress ?? null,
            remotePort: socket.remotePort ?? null,
          }
        : null,
      trace: this.trace.map((entry) => ({ ...entry })),
    };
  }
}
