import type { Socket } from 'node:net';
import type WebSocket from 'ws';

/** Counters describe local writes, never delivery to the peer. */
export interface ConnectorWriteSnapshot {
  generation: number;
  bufferedAmount: number;
  writableLength?: number;
  writableNeedDrain?: boolean;
  /** Transport lifetime counter, including the HTTP upgrade; not peer acknowledgements. */
  bytesWritten?: number;
  drainCount: number;
  lastDrainAgoMs?: number;
  /** Raw HTTP response bytes read upstream, including bytes later dropped. */
  responseBytes: number;
  /** Cumulative UTF-8 JSON frame bytes offered to send, excluding WS/TLS overhead. */
  encodedBytes: number;
  frames: number;
  /** Largest bufferedAmount observed after a frame send or during a snapshot. */
  queueHighWaterBytes: number;
  pendingFlushes: number;
  /** Frame bytes whose local write callback has not settled (success or error). */
  pendingEncodedBytes: number;
}

export class ConnectorWrites {
  private transport: Socket | undefined;
  private drains = 0;
  private lastDrain: number | undefined;
  private responseBytes = 0;
  private encodedBytes = 0;
  private frames = 0;
  private highWater = 0;
  private pending = 0;
  private pendingBytes = 0;

  constructor(private readonly generation: number) {}

  attach(socket: Socket): void {
    this.transport = socket;
    const drain = (): void => {
      this.drains += 1;
      this.lastDrain = performance.now();
    };
    socket.on('drain', drain);
    socket.once('close', () => socket.off('drain', drain));
  }

  body(bytes: number): void {
    this.responseBytes += bytes;
  }

  enqueue(bytes: number): () => void {
    this.encodedBytes += bytes;
    this.frames += 1;
    this.pending += 1;
    this.pendingBytes += bytes;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.pending -= 1;
      this.pendingBytes -= bytes;
    };
  }

  observe(socket: WebSocket): void {
    this.highWater = Math.max(this.highWater, socket.bufferedAmount);
  }

  sample(socket: WebSocket): ConnectorWriteSnapshot {
    this.observe(socket);
    const transport = this.transport;
    return {
      generation: this.generation,
      bufferedAmount: socket.bufferedAmount,
      ...(transport
        ? {
            writableLength: transport.writableLength,
            writableNeedDrain: transport.writableNeedDrain,
            bytesWritten: transport.bytesWritten,
          }
        : {}),
      drainCount: this.drains,
      ...(this.lastDrain === undefined
        ? {}
        : { lastDrainAgoMs: Math.max(0, Math.floor(performance.now() - this.lastDrain)) }),
      responseBytes: this.responseBytes,
      encodedBytes: this.encodedBytes,
      frames: this.frames,
      queueHighWaterBytes: this.highWater,
      pendingFlushes: this.pending,
      pendingEncodedBytes: this.pendingBytes,
    };
  }
}

export const connectorWrites = new WeakMap<WebSocket, ConnectorWrites>();
