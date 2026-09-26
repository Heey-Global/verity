import { createConnection, type Socket } from 'node:net';
import WebSocket from 'ws';
import type {
  RemoteConnectorRequest,
  RemoteConnectorReservation,
} from './uplink-control-client.js';

const MAX_SESSIONS = 4;
const MAX_STREAMS = 8;
const MAX_STREAM_IDS = 4_096;
const MAX_FRAME_BYTES = 96 * 1_024;
const MAX_CHUNK_BYTES = 64 * 1_024;
const MAX_STREAM_QUEUE_BYTES = 256 * 1_024;
const MAX_SOCKET_QUEUE_BYTES = 1_024 * 1_024;
const LOCAL_DIAL_TIMEOUT_MS = 10_000;
const STALLED_QUEUE_TIMEOUT_MS = 30_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TICKET = /^[A-Za-z0-9_-]{1,512}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

type Frame = Record<string, unknown>;
type ResetCode = 'protocol_error' | 'concurrency_limit' | 'upstream_error' | 'timeout';

interface Stream {
  socket: Socket;
  incomingSeq: number;
  outgoingSeq: number;
  incomingEnded: boolean;
  outgoingEnded: boolean;
  dialTimer: NodeJS.Timeout;
  stallTimer: NodeJS.Timeout | undefined;
  outgoingStallTimer: NodeJS.Timeout | undefined;
  outgoingPaused: boolean;
}

export interface RemoteConnectorPoolOptions {
  /** Fixed Uplink data endpoint. Tickets are sent only in the first WebSocket frame. */
  dataUrl: string;
  /** Fixed local TLS ingress; never derived from a session request or stream frame. */
  localHost: string;
  localPort: number;
  webSocketFactory?: (url: string, options: { maxPayload: number }) => WebSocket;
  connectLocal?: (host: string, port: number) => Socket;
}

/** A bounded, opt-in connector. Construction does not activate remote admission. */
export function createRemoteConnectorPool(options: RemoteConnectorPoolOptions): {
  reserve: (
    request: RemoteConnectorRequest,
    signal: AbortSignal,
  ) => Promise<RemoteConnectorReservation | 'unavailable' | 'limit_reached'>;
} {
  const dataUrl = new URL(options.dataUrl);
  if (
    dataUrl.protocol !== 'wss:' ||
    dataUrl.pathname !== '/data' ||
    dataUrl.search ||
    dataUrl.hash ||
    dataUrl.username ||
    dataUrl.password
  ) {
    throw new Error('remote connector requires a fixed WSS /data endpoint');
  }
  if (
    !options.localHost ||
    /[\s/:\\]/u.test(options.localHost) ||
    !Number.isInteger(options.localPort) ||
    options.localPort < 1 ||
    options.localPort > 65_535
  ) {
    throw new Error('remote connector requires a fixed local TLS ingress');
  }
  const sessions = new Set<ConnectorSession>();
  return {
    reserve: (request, signal) => {
      if (signal.aborted) return Promise.resolve('unavailable');
      if (sessions.size >= MAX_SESSIONS) return Promise.resolve('limit_reached');
      const session = new ConnectorSession(options, request, () => sessions.delete(session));
      sessions.add(session);
      signal.addEventListener('abort', () => session.release('admission aborted'), { once: true });
      if (signal.aborted) session.release('admission aborted');
      return Promise.resolve(session);
    },
  };
}

class ConnectorSession implements RemoteConnectorReservation {
  readonly closed: Promise<void>;
  private resolveClosed: () => void = () => undefined;
  private ws?: WebSocket;
  private terminated = false;
  private ready = false;
  private streams = new Map<string, Stream>();
  private usedIds = new Set<string>();
  private locallyResetIds = new Set<string>();
  private attachReject: ((error: Error) => void) | undefined;
  private attachTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: RemoteConnectorPoolOptions,
    private readonly request: RemoteConnectorRequest,
    private readonly onRelease: () => void,
  ) {
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async attach(ticket: string, expiresAt: number, signal: AbortSignal): Promise<void> {
    if (
      this.terminated ||
      this.ws ||
      signal.aborted ||
      !TICKET.test(ticket) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt - Date.now() > 60_000
    ) {
      throw new Error('remote connector attachment unavailable');
    }
    const ws = (this.options.webSocketFactory ?? ((url, settings) => new WebSocket(url, settings)))(
      this.options.dataUrl,
      { maxPayload: MAX_FRAME_BYTES },
    );
    this.ws = ws;
    const onAbort = () => this.release('remote attachment aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        this.attachReject = reject;
        const remaining = Math.min(expiresAt - Date.now(), 2_147_483_647);
        this.attachTimer = setTimeout(() => this.release('remote ticket expired'), remaining);
        this.attachTimer.unref();
        ws.on('open', () => {
          if (!this.terminated) ws.send(JSON.stringify({ type: 'attach', ticket }));
        });
        ws.on('message', (data, isBinary) => {
          if (this.terminated) return;
          if (isBinary || !Buffer.isBuffer(data) || data.byteLength > MAX_FRAME_BYTES) {
            this.failProtocol();
            return;
          }
          let frame: unknown;
          try {
            frame = JSON.parse(data.toString('utf8'));
          } catch {
            this.failProtocol();
            return;
          }
          if (!this.ready) {
            if (
              !isFrame(frame, 'attached', ['sessionId', 'capability']) ||
              frame.sessionId !== this.request.sessionId ||
              frame.capability !== 'remote-control-v1'
            ) {
              this.failProtocol();
              return;
            }
            this.ready = true;
            if (this.attachTimer) clearTimeout(this.attachTimer);
            this.attachTimer = undefined;
            this.attachReject = undefined;
            resolve();
            return;
          }
          try {
            this.handleFrame(frame);
          } catch {
            this.release('remote stream failed');
          }
        });
        ws.on('error', () => this.release('remote data connection failed'));
        ws.on('close', () => this.release('remote data connection closed'));
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  release(reason: string): void {
    if (this.terminated) return;
    this.terminated = true;
    if (this.attachTimer) clearTimeout(this.attachTimer);
    this.attachReject?.(new Error(reason));
    this.attachReject = undefined;
    for (const [id] of this.streams) this.dropStream(id);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000);
    else if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate();
    this.onRelease();
    this.resolveClosed();
  }

  private failProtocol(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1008, 'invalid remote frame');
    this.release('invalid remote frame');
  }

  private send(frame: Frame): void {
    const ws = this.ws;
    if (this.terminated || !this.ready || ws?.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify(frame);
    if (
      Buffer.byteLength(raw) > MAX_FRAME_BYTES ||
      ws.bufferedAmount + Buffer.byteLength(raw) > MAX_SOCKET_QUEUE_BYTES
    ) {
      this.release('remote data queue exceeded');
      return;
    }
    ws.send(raw, (error) => {
      if (error) this.release('remote data send failed');
      else this.resumePausedStreams();
    });
  }

  private resumePausedStreams(): void {
    if ((this.ws?.bufferedAmount ?? 0) >= MAX_SOCKET_QUEUE_BYTES / 2) return;
    for (const stream of this.streams.values()) {
      if (!stream.outgoingPaused) continue;
      stream.outgoingPaused = false;
      if (stream.outgoingStallTimer) clearTimeout(stream.outgoingStallTimer);
      stream.outgoingStallTimer = undefined;
      stream.socket.resume();
    }
  }

  private reset(id: string, code: ResetCode): void {
    if (!this.streams.has(id)) return;
    this.locallyResetIds.add(id);
    this.dropStream(id);
    this.send({ type: 'stream.reset', streamId: id, code });
  }

  private dropStream(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    clearTimeout(stream.dialTimer);
    if (stream.stallTimer) clearTimeout(stream.stallTimer);
    if (stream.outgoingStallTimer) clearTimeout(stream.outgoingStallTimer);
    stream.socket.destroy();
  }

  private finishStreamIfComplete(id: string, stream: Stream): void {
    if (stream.incomingEnded && stream.outgoingEnded && stream.socket.writableFinished)
      this.dropStream(id);
  }

  private updateIncomingStall(id: string, stream: Stream, progressed: boolean): void {
    if (progressed && stream.stallTimer) {
      clearTimeout(stream.stallTimer);
      stream.stallTimer = undefined;
    }
    if (stream.socket.writableLength === 0) {
      if (stream.stallTimer) clearTimeout(stream.stallTimer);
      stream.stallTimer = undefined;
      return;
    }
    if (stream.stallTimer) return;
    stream.stallTimer = setTimeout(() => this.reset(id, 'timeout'), STALLED_QUEUE_TIMEOUT_MS);
    stream.stallTimer.unref();
  }

  private handleFrame(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return this.failProtocol();
    const frame = value as Frame;
    if (frame.type === 'stream.open') {
      if (
        !isFrame(frame, 'stream.open', ['streamId', 'channel', 'meta']) ||
        !validId(frame.streamId) ||
        frame.channel !== 'remote' ||
        !frame.meta ||
        typeof frame.meta !== 'object' ||
        Array.isArray(frame.meta) ||
        Object.keys(frame.meta).length !== 0 ||
        this.usedIds.has(frame.streamId)
      )
        return this.failProtocol();
      const id = frame.streamId;
      if (this.usedIds.size >= MAX_STREAM_IDS)
        return this.release('remote stream ID limit reached');
      this.usedIds.add(id);
      if (this.streams.size >= MAX_STREAMS) {
        this.locallyResetIds.add(id);
        this.send({ type: 'stream.reset', streamId: id, code: 'concurrency_limit' });
        return;
      }
      const socket = (
        this.options.connectLocal ??
        ((host, port) => createConnection({ host, port, allowHalfOpen: true }))
      )(this.options.localHost, this.options.localPort);
      const stream: Stream = {
        socket,
        incomingSeq: 0,
        outgoingSeq: 0,
        incomingEnded: false,
        outgoingEnded: false,
        dialTimer: setTimeout(() => this.reset(id, 'upstream_error'), LOCAL_DIAL_TIMEOUT_MS),
        stallTimer: undefined,
        outgoingStallTimer: undefined,
        outgoingPaused: false,
      };
      stream.dialTimer.unref();
      this.streams.set(id, stream);
      socket.on('connect', () => clearTimeout(stream.dialTimer));
      socket.on('data', (chunk: Buffer) => {
        if (this.terminated || !this.streams.has(id)) return;
        for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK_BYTES) {
          const piece = chunk.subarray(offset, offset + MAX_CHUNK_BYTES);
          this.send({
            type: 'stream.data',
            streamId: id,
            seq: stream.outgoingSeq++,
            payload: piece.toString('base64'),
          });
          if (this.terminated) return;
        }
        if ((this.ws?.bufferedAmount ?? 0) > MAX_SOCKET_QUEUE_BYTES / 2) {
          stream.outgoingPaused = true;
          socket.pause();
          if (!stream.outgoingStallTimer) {
            stream.outgoingStallTimer = setTimeout(
              () => this.reset(id, 'timeout'),
              STALLED_QUEUE_TIMEOUT_MS,
            );
            stream.outgoingStallTimer.unref();
          }
        }
      });
      socket.on('end', () => {
        stream.outgoingEnded = true;
        this.send({ type: 'stream.end', streamId: id });
        this.finishStreamIfComplete(id, stream);
      });
      socket.on('finish', () => this.finishStreamIfComplete(id, stream));
      socket.on('error', () => this.reset(id, 'upstream_error'));
      socket.on('close', () => {
        if (this.streams.has(id)) this.reset(id, 'upstream_error');
      });
      return;
    }
    if (!validId(frame.streamId)) return this.failProtocol();
    const id = frame.streamId;
    const stream = this.streams.get(id);
    if (!stream) {
      if (this.locallyResetIds.has(id) && validIgnoredFrame(frame)) return;
      return this.failProtocol();
    }
    if (frame.type === 'stream.data') {
      if (
        !isFrame(frame, 'stream.data', ['streamId', 'seq', 'payload']) ||
        stream.incomingEnded ||
        frame.seq !== stream.incomingSeq ||
        !Number.isSafeInteger(frame.seq) ||
        typeof frame.payload !== 'string' ||
        !BASE64.test(frame.payload)
      )
        return this.failProtocol();
      const bytes = Buffer.from(frame.payload, 'base64');
      if (bytes.length > MAX_CHUNK_BYTES || bytes.toString('base64') !== frame.payload)
        return this.failProtocol();
      stream.incomingSeq++;
      if (bytes.length === 0) return;
      stream.socket.write(bytes, () => {
        if (this.streams.get(id) === stream) this.updateIncomingStall(id, stream, true);
      });
      if (stream.socket.writableLength > MAX_STREAM_QUEUE_BYTES) this.reset(id, 'upstream_error');
      else this.updateIncomingStall(id, stream, false);
      return;
    }
    if (frame.type === 'stream.end') {
      if (!isFrame(frame, 'stream.end', ['streamId']) || stream.incomingEnded)
        return this.failProtocol();
      stream.incomingEnded = true;
      stream.socket.end();
      this.finishStreamIfComplete(id, stream);
      return;
    }
    if (frame.type === 'stream.reset') {
      if (
        !isFrame(frame, 'stream.reset', ['streamId', 'code']) ||
        !['protocol_error', 'concurrency_limit', 'upstream_error', 'timeout'].includes(
          String(frame.code),
        )
      )
        return this.failProtocol();
      this.dropStream(id);
      return;
    }
    this.failProtocol();
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function validIgnoredFrame(frame: Frame): boolean {
  if (frame.type === 'stream.end') return isFrame(frame, 'stream.end', ['streamId']);
  if (frame.type === 'stream.reset')
    return (
      isFrame(frame, 'stream.reset', ['streamId', 'code']) &&
      ['protocol_error', 'concurrency_limit', 'upstream_error', 'timeout'].includes(
        String(frame.code),
      )
    );
  if (
    frame.type !== 'stream.data' ||
    !isFrame(frame, 'stream.data', ['streamId', 'seq', 'payload']) ||
    !Number.isSafeInteger(frame.seq) ||
    (frame.seq as number) < 0 ||
    typeof frame.payload !== 'string' ||
    !BASE64.test(frame.payload)
  )
    return false;
  const bytes = Buffer.from(frame.payload, 'base64');
  return bytes.length <= MAX_CHUNK_BYTES && bytes.toString('base64') === frame.payload;
}

function isFrame(value: unknown, type: string, fields: readonly string[]): value is Frame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Frame;
  const expected = ['type', ...fields];
  return (
    frame.type === type &&
    Object.keys(frame).length === expected.length &&
    expected.every((key) => Object.hasOwn(frame, key))
  );
}
