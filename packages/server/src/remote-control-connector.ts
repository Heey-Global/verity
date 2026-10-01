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
// What Core sends per stream.data frame towards the app. The protocol allows
// 64 KiB, and the hosted Uplink delivered every frame of a TLS handshake flight
// (about 3 KB each) while the response frames behind them, about 30 KB each,
// never reached the paired device, with no reset and no close to say why.
// Smaller frames keep each one well inside whatever the relay actually passes.
// This is a mitigation for an unconfirmed cause, not a fix: the Uplink side
// reports no size-based drop in its code. The frame counts in the stream
// records show whether the loss stops; if it does not, the cause is elsewhere
// (a per-connection window, a rate limit) and this should be reverted. The
// incoming bound above stays at the protocol's 64 KiB.
const SEND_CHUNK_BYTES = 8 * 1_024;
const MAX_STREAM_QUEUE_BYTES = 256 * 1_024;
const MAX_SOCKET_QUEUE_BYTES = 1_024 * 1_024;
const LOCAL_DIAL_TIMEOUT_MS = 10_000;
const STALLED_QUEUE_TIMEOUT_MS = 30_000;
const DATA_PING_INTERVAL_MS = 15_000;
const DATA_PONG_DEADLINE_MS = 45_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TICKET = /^[A-Za-z0-9_-]{1,512}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

type Frame = Record<string, unknown>;
type ResetCode = 'protocol_error' | 'concurrency_limit' | 'upstream_error' | 'timeout';

type ByteCounter =
  'receivedFromAppBytes' | 'writtenToLocalBytes' | 'receivedFromLocalBytes' | 'sentToUplinkBytes';

interface Stream {
  startedAt: number;
  firstLocalReplyAt: number | undefined;
  receivedFromAppBytes: number;
  writtenToLocalBytes: number;
  receivedFromLocalBytes: number;
  sentToUplinkBytes: number;
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

/**
 * Core's side of one tunnel stream, for the paired app's diagnostics screen.
 * The app shows its own byte counts per stream; without this view, which side
 * lost a reply can only be read from the server log, which a phone cannot.
 * Counters only: no payload, ticket or address ever leaves through this.
 */
export interface RemoteStreamRecord {
  sessionId: string;
  /** First eight characters of the stream ID, enough to match the app's trace. */
  streamId: string;
  startedAt: number;
  durationMs: number;
  /** Milliseconds from open until the local TLS ingress first answered. */
  firstLocalReplyMs: number | null;
  receivedFromAppBytes: number;
  writtenToLocalBytes: number;
  receivedFromLocalBytes: number;
  sentToUplinkBytes: number;
  /** stream.data frames each way; against the app's count they show where a frame was lost. */
  framesFromApp: number;
  framesToApp: number;
  /** 'open' while live; otherwise the fixed reason the stream ended with. */
  state: string;
}

const RECENT_STREAMS = 8;

export interface RemoteConnectorPoolOptions {
  /** Fixed Uplink data endpoint. Tickets are sent only in the first WebSocket frame. */
  dataUrl: string;
  /** Fixed local TLS ingress; never derived from a session request or stream frame. */
  localHost: string;
  localPort: number;
  webSocketFactory?: (url: string, options: { maxPayload: number }) => WebSocket;
  connectLocal?: (host: string, port: number) => Socket;
  /** Records why sessions end and streams reset; otherwise a failure only surfaces as a generic app error. */
  log?: Pick<Console, 'info' | 'warn'>;
}

export function remoteDataUrlForControl(controlUrl: string): string {
  const url = new URL(controlUrl);
  if (
    url.protocol !== 'wss:' ||
    url.pathname !== '/control' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('remote connector requires a fixed WSS /control endpoint');
  url.pathname = '/data';
  return url.href;
}

/** A bounded, opt-in connector. Construction does not activate remote admission. */
export function createRemoteConnectorPool(options: RemoteConnectorPoolOptions): {
  reserve: (
    request: RemoteConnectorRequest,
    signal: AbortSignal,
  ) => Promise<RemoteConnectorReservation | 'unavailable' | 'limit_reached'>;
  /** Live streams first, then the most recently ended ones, newest last. */
  recentStreams: () => RemoteStreamRecord[];
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
  const ended: RemoteStreamRecord[] = [];
  const retain = (record: RemoteStreamRecord): void => {
    ended.push(record);
    if (ended.length > RECENT_STREAMS) ended.shift();
  };
  return {
    // Bounded as a whole: the app rejects an oversized list, and many live
    // streams is exactly the situation this view is read in. The newest live
    // streams are the ones the user just tested, so they are what survives.
    recentStreams: () => {
      const live = [...sessions]
        .flatMap((session) => session.liveStreams())
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(-RECENT_STREAMS);
      return [...live, ...ended.slice(Math.max(0, ended.length - (RECENT_STREAMS - live.length)))];
    },
    reserve: (request, signal) => {
      if (signal.aborted) return Promise.resolve('unavailable');
      if (sessions.size >= MAX_SESSIONS) return Promise.resolve('limit_reached');
      const session = new ConnectorSession(
        options,
        request,
        () => sessions.delete(session),
        retain,
      );
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
  private retiredIds = new Set<string>();
  private attachReject: ((error: Error) => void) | undefined;
  private attachTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private unansweredPingSince: number | undefined;

  constructor(
    private readonly options: RemoteConnectorPoolOptions,
    private readonly request: RemoteConnectorRequest,
    private readonly onRelease: () => void,
    private readonly onStreamEnded: (record: RemoteStreamRecord) => void = () => undefined,
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
            this.failProtocol({ type: isBinary ? '(binary)' : '(oversize)' });
            return;
          }
          let frame: unknown;
          try {
            frame = JSON.parse(data.toString('utf8'));
          } catch {
            this.failProtocol({ type: '(unparseable)' });
            return;
          }
          if (!this.ready) {
            if (
              !isFrame(frame, 'attached', ['sessionId', 'capability']) ||
              frame.sessionId !== this.request.sessionId ||
              frame.capability !== 'remote-control-v1'
            ) {
              this.failProtocol(frame);
              return;
            }
            this.ready = true;
            if (this.attachTimer) clearTimeout(this.attachTimer);
            this.attachTimer = undefined;
            this.attachReject = undefined;
            this.startHeartbeat(ws);
            resolve();
            return;
          }
          try {
            this.handleFrame(frame);
          } catch (error) {
            this.options.log?.warn(
              { sessionId: this.request.sessionId, error },
              'remote connector stream handling failed',
            );
            this.release('remote stream failed');
          }
        });
        ws.on('error', (error) => {
          this.options.log?.warn(
            { sessionId: this.request.sessionId, error },
            'remote data connection error',
          );
          this.release('remote data connection failed');
        });
        ws.on('close', (code, reason) =>
          this.release(
            `remote data connection closed (${String(code)}${reason.length ? `: ${reason.toString('utf8').slice(0, 64)}` : ''})`,
          ),
        );
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  // An attached session has no wall-clock limit, so a data socket that went
  // half-open without a close would otherwise hold its reservation and local
  // sockets indefinitely. A ping unanswered for more than 45 seconds ends the
  // session on the next 15-second tick, so within 60 seconds.
  private startHeartbeat(ws: WebSocket): void {
    ws.on('pong', () => {
      this.unansweredPingSince = undefined;
    });
    this.heartbeat = setInterval(() => {
      if (this.terminated || ws.readyState !== WebSocket.OPEN) return;
      if (this.unansweredPingSince === undefined) {
        this.unansweredPingSince = Date.now();
        ws.ping();
      } else if (Date.now() - this.unansweredPingSince > DATA_PONG_DEADLINE_MS) {
        ws.terminate();
        this.release('remote data heartbeat timeout');
      }
    }, DATA_PING_INTERVAL_MS);
    this.heartbeat.unref();
  }

  liveStreams(): RemoteStreamRecord[] {
    return [...this.streams].map(([id, stream]) => this.record(id, stream, 'open'));
  }

  private record(id: string, stream: Stream, state: string): RemoteStreamRecord {
    const now = Date.now();
    return {
      sessionId: this.request.sessionId,
      streamId: id.slice(0, 8),
      startedAt: stream.startedAt,
      durationMs: now - stream.startedAt,
      firstLocalReplyMs:
        stream.firstLocalReplyAt === undefined ? null : stream.firstLocalReplyAt - stream.startedAt,
      receivedFromAppBytes: stream.receivedFromAppBytes,
      writtenToLocalBytes: stream.writtenToLocalBytes,
      receivedFromLocalBytes: stream.receivedFromLocalBytes,
      sentToUplinkBytes: stream.sentToUplinkBytes,
      framesFromApp: stream.incomingSeq,
      framesToApp: stream.outgoingSeq,
      // Reasons are fixed literals, but the app drops the whole list on an overlong one.
      state: state.slice(0, 64),
    };
  }

  release(reason: string): void {
    if (this.terminated) return;
    this.terminated = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.options.log?.info(
      {
        sessionId: this.request.sessionId,
        reason,
        attached: this.ready,
        openStreams: this.streams.size,
        usedStreamIds: this.usedIds.size,
      },
      'remote connector session ended',
    );
    if (this.attachTimer) clearTimeout(this.attachTimer);
    this.attachReject?.(new Error(reason));
    this.attachReject = undefined;
    for (const [id] of this.streams) this.dropStream(id, 'session_ended');
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000);
    else if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate();
    this.onRelease();
    this.resolveClosed();
  }

  private failProtocol(frame?: unknown): void {
    // Only the frame type: payloads are inner TLS records and stream IDs are enough to correlate.
    const type =
      frame && typeof frame === 'object' && !Array.isArray(frame)
        ? String((frame as Frame).type).slice(0, 32)
        : typeof frame;
    this.options.log?.warn(
      { sessionId: this.request.sessionId, frameType: type, attached: this.ready },
      'remote connector rejected an invalid data frame',
    );
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1008, 'invalid remote frame');
    this.release('invalid remote frame');
  }

  private send(frame: Frame, onSent?: () => void): void {
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
      else {
        onSent?.();
        this.resumePausedStreams();
      }
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
    this.options.log?.warn(
      { sessionId: this.request.sessionId, streamId: id, code },
      'remote connector reset a stream',
    );
    this.dropStream(id, `local_reset:${code}`);
    this.send({ type: 'stream.reset', streamId: id, code });
  }

  private dropStream(id: string, reason: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.onStreamEnded(this.record(id, stream, reason));
    this.options.log?.info(
      {
        sessionId: this.request.sessionId,
        streamId: id,
        reason,
        durationMs: Date.now() - stream.startedAt,
        receivedFromAppBytes: stream.receivedFromAppBytes,
        writtenToLocalBytes: stream.writtenToLocalBytes,
        receivedFromLocalBytes: stream.receivedFromLocalBytes,
        sentToUplinkBytes: stream.sentToUplinkBytes,
        incomingEnded: stream.incomingEnded,
        outgoingEnded: stream.outgoingEnded,
      },
      'remote connector stream ended',
    );
    // A peer reset can arrive after both ends completed; keep its ID retired
    // so it cannot close the shared data socket.
    this.retiredIds.add(id);
    this.streams.delete(id);
    clearTimeout(stream.dialTimer);
    if (stream.stallTimer) clearTimeout(stream.stallTimer);
    if (stream.outgoingStallTimer) clearTimeout(stream.outgoingStallTimer);
    stream.socket.destroy();
  }

  private finishStreamIfComplete(id: string, stream: Stream): void {
    if (stream.incomingEnded && stream.outgoingEnded && stream.socket.writableFinished)
      this.dropStream(id, 'complete');
  }

  // Successful write callbacks mean local transport acceptance, not peer TLS/HTTP processing.
  private recordBytes(id: string, stream: Stream, counter: ByteCounter, bytes: number): void {
    if (this.streams.get(id) !== stream || bytes === 0) return;
    const first = stream[counter] === 0;
    stream[counter] += bytes;
    if (first && counter === 'receivedFromLocalBytes') stream.firstLocalReplyAt = Date.now();
    if (first)
      this.options.log?.info(
        {
          sessionId: this.request.sessionId,
          streamId: id,
          counter,
          bytes,
          durationMs: Date.now() - stream.startedAt,
        },
        'remote connector first bytes',
      );
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
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return this.failProtocol(value);
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
        return this.failProtocol(frame);
      const id = frame.streamId;
      if (this.usedIds.size >= MAX_STREAM_IDS)
        return this.release('remote stream ID limit reached');
      this.usedIds.add(id);
      if (this.streams.size >= MAX_STREAMS) {
        this.retiredIds.add(id);
        this.send({ type: 'stream.reset', streamId: id, code: 'concurrency_limit' });
        return;
      }
      const socket = (
        this.options.connectLocal ??
        ((host, port) => createConnection({ host, port, allowHalfOpen: true }))
      )(this.options.localHost, this.options.localPort);
      const stream: Stream = {
        startedAt: Date.now(),
        firstLocalReplyAt: undefined,
        receivedFromAppBytes: 0,
        writtenToLocalBytes: 0,
        receivedFromLocalBytes: 0,
        sentToUplinkBytes: 0,
        socket,
        incomingSeq: 0,
        outgoingSeq: 0,
        incomingEnded: false,
        outgoingEnded: false,
        dialTimer: setTimeout(() => {
          this.options.log?.warn(
            {
              stage: 'local_ingress',
              sessionId: this.request.sessionId,
              streamId: id,
              code: 'dial_timeout',
            },
            'remote connector could not reach local TLS ingress',
          );
          this.reset(id, 'upstream_error');
        }, LOCAL_DIAL_TIMEOUT_MS),
        stallTimer: undefined,
        outgoingStallTimer: undefined,
        outgoingPaused: false,
      };
      stream.dialTimer.unref();
      this.streams.set(id, stream);
      socket.on('connect', () => {
        clearTimeout(stream.dialTimer);
        this.options.log?.info(
          {
            stage: 'local_ingress',
            sessionId: this.request.sessionId,
            streamId: id,
            localPort: socket.localPort,
          },
          'remote connector reached local TLS ingress',
        );
      });
      socket.on('data', (chunk: Buffer) => {
        if (this.terminated || !this.streams.has(id)) return;
        this.recordBytes(id, stream, 'receivedFromLocalBytes', chunk.length);
        for (let offset = 0; offset < chunk.length; offset += SEND_CHUNK_BYTES) {
          const piece = chunk.subarray(offset, offset + SEND_CHUNK_BYTES);
          this.send(
            {
              type: 'stream.data',
              streamId: id,
              seq: stream.outgoingSeq++,
              payload: piece.toString('base64'),
            },
            () => this.recordBytes(id, stream, 'sentToUplinkBytes', piece.length),
          );
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
      socket.on('error', (error: NodeJS.ErrnoException) => {
        // Error messages may contain addresses. Keep only known OS failure codes.
        const code = [
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
          'ENOTFOUND',
          'EHOSTUNREACH',
          'ENETUNREACH',
          'EPIPE',
        ].includes(error.code ?? '')
          ? error.code
          : 'socket_error';
        this.options.log?.warn(
          { stage: 'local_ingress', sessionId: this.request.sessionId, streamId: id, code },
          'remote connector local TLS ingress failed',
        );
        this.reset(id, 'upstream_error');
      });
      socket.on('close', () => {
        if (this.streams.has(id)) this.reset(id, 'upstream_error');
      });
      return;
    }
    if (!validId(frame.streamId)) return this.failProtocol(frame);
    const id = frame.streamId;
    const stream = this.streams.get(id);
    if (!stream) {
      if (this.retiredIds.has(id) && validIgnoredFrame(frame)) return;
      return this.failProtocol(frame);
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
        return this.failProtocol(frame);
      const bytes = Buffer.from(frame.payload, 'base64');
      if (bytes.length > MAX_CHUNK_BYTES || bytes.toString('base64') !== frame.payload)
        return this.failProtocol(frame);
      stream.incomingSeq++;
      if (bytes.length === 0) return;
      this.recordBytes(id, stream, 'receivedFromAppBytes', bytes.length);
      stream.socket.write(bytes, (error) => {
        if (error) return;
        this.recordBytes(id, stream, 'writtenToLocalBytes', bytes.length);
        if (this.streams.get(id) === stream) this.updateIncomingStall(id, stream, true);
      });
      if (stream.socket.writableLength > MAX_STREAM_QUEUE_BYTES) this.reset(id, 'upstream_error');
      else this.updateIncomingStall(id, stream, false);
      return;
    }
    if (frame.type === 'stream.end') {
      if (!isFrame(frame, 'stream.end', ['streamId']) || stream.incomingEnded)
        return this.failProtocol(frame);
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
        return this.failProtocol(frame);
      this.options.log?.info(
        { sessionId: this.request.sessionId, streamId: id, code: frame.code },
        'remote app reset a stream',
      );
      this.dropStream(id, `peer_reset:${String(frame.code)}`);
      return;
    }
    this.failProtocol(frame);
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
