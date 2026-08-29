import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { isIP } from 'node:net';
import { URL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

import {
  encodedPayloadLimit,
  FORBIDDEN_REQUEST_HEADERS,
  HOP_BY_HOP,
  isHttpRequestMeta,
  isHttpResponseMeta,
  isSubprotocolToken,
  isWsAcceptMeta,
  isWsOpenMeta,
  sendableCloseCode,
  validHeaders,
  validStreamFrame,
  type HttpRequestMeta,
  type StreamFrame,
  type StreamResetCode,
  type HttpResponseMeta,
  type WsAcceptMeta,
  type WsOpenMeta,
} from './framing.js';
import { StreamRegistry } from './streams.js';

const LOGIN_PATH = '/__verity/login';
const CONNECTOR_PATH = '/__verity/connector';
const COOKIE_NAME = '__Host-verity-preview';
const MAX_LOGIN_IDENTITIES = 1024;
const CONNECTOR_HEARTBEAT_MS = 15_000;

export interface PreviewEdgeOptions {
  shareId: string;
  pinHash: string;
  connectorTokenHash: string;
  sessionSecretHash: string;
  publicOrigin: string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  /**
   * Ceiling for streams, which leave the request pool so a stalled EventSource
   * cannot starve page loads. The total in flight is therefore this plus
   * `maxConcurrentRequests`; it is a separate knob so that sum stays a stated
   * bound rather than a silent doubling of one.
   */
  maxConcurrentStreams?: number;
  trustedProxyHops?: number;
  /** Absolute expiry enforced inside the edge even when Verity is unavailable. */
  expiresAt?: string;
}

export interface PreviewConnectorOptions {
  edgeUrl: string;
  connectorToken: string;
  targetOrigin: string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  /**
   * Ceiling for streams, which leave the request pool so a stalled EventSource
   * cannot starve page loads. The total in flight is therefore this plus
   * `maxConcurrentRequests`; it is a separate knob so that sum stays a stated
   * bound rather than a silent doubling of one.
   */
  maxConcurrentStreams?: number;
}

/**
 * What the edge does with frames arriving for one stream. Deliberately shaped
 * around the protocol's frames rather than around HTTP, so the `ws` channel uses
 * the same four callbacks the `http` channel does.
 */
interface EdgeStream {
  /** The peer's `stream.open` in the reply direction: an http status line, or a
   * `ws` acceptance carrying the subprotocol the target selected. */
  head: (meta: HttpResponseMeta | WsAcceptMeta) => void;
  data: (payload: Buffer, opcode: 'text' | 'binary' | undefined) => void;
  end: (meta: { code?: number; reason?: string } | undefined) => void;
  /** The stream died: reset by the peer, or torn down from this side. */
  fail: (error: Error) => void;
}

/** One exchange the connector is relaying to the target. The request body is
 * collected here rather than piped into `fetch` as it arrives: the edge already
 * buffers the whole body against `maxBodyBytes` before opening the stream, so
 * there is never more than one data frame to wait for. */
interface ConnectorStreamBase {
  /** Counted against the request pool until the exchange outlives the deadline. */
  counted: boolean;
  /** Counted against the stream pool from that point on. */
  streaming: boolean;
}

interface ConnectorHttpStream extends ConnectorStreamBase {
  channel: 'http';
  meta: HttpRequestMeta;
  chunks: Buffer[];
  cancelled: AbortController;
  headSent: boolean;
  /** Why the body relay is being torn down, when it is not an upstream fault. */
  failureCode?: StreamResetCode;
}

/** One application WebSocket the connector is bridging to the target. A `ws`
 * reply direction opens only once the target has accepted, which is also when
 * the edge is told to complete its own handshake. */
interface ConnectorWsStream extends ConnectorStreamBase {
  channel: 'ws';
  socket: WebSocket;
  /** Whether the target accepted. Nothing arrives from the edge before this:
   * until then it has no client of its own to relay for. */
  open: boolean;
}

type ConnectorStream = ConnectorHttpStream | ConnectorWsStream;

class RequestBodyError extends Error {}

/** Consecutive failed connect attempts the connector supervisor tolerates before
 * it gives up and lets the process exit — a crash the orchestrator restarts. */
export const CONNECTOR_MAX_RECONNECT_ATTEMPTS = 10;

/** Delay before reconnect attempt `attempt` (0-based, reset by every successful
 * connect): exponential from one second, capped at fifteen so a long edge outage
 * settles into steady polling instead of growing unbounded.
 *
 * Lives here rather than in connector-main.ts so it is reachable from a test:
 * the supervisor loop around it is top-level module code that connects on
 * import, which no unit test can enter. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 15_000);
}

export function hashPreviewSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generatePreviewSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashPreviewPin(pin: string, salt = randomBytes(16).toString('hex')): string {
  if (!/^\d{6,12}$/.test(pin)) throw new Error('preview PIN must contain 6 to 12 digits');
  return `scrypt:${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

export class PreviewEdge {
  private readonly options: Required<PreviewEdgeOptions>;
  private readonly server: Server;
  private readonly websocketServer: WebSocketServer;
  private readonly clientSockets: WebSocketServer;
  /** The subprotocol the target selected for the handshake being completed right
   * now, or `false` for none. Only ever set across one synchronous
   * `handleUpgrade` call. */
  private selectedProtocol: string | false = false;
  private readonly streams: StreamRegistry<EdgeStream>;
  private readonly loginFailures = new Map<string, number[]>();
  private connector: WebSocket | undefined;
  private activeRequests = 0;
  private activeStreams = 0;
  private loginVerifications = 0;
  private readonly expiresAtMs: number;
  private readonly expiryTimer: NodeJS.Timeout | undefined;

  constructor(options: PreviewEdgeOptions) {
    validatePinHash(options.pinHash);
    validateHash(options.connectorTokenHash, 'connectorTokenHash');
    validateHash(options.sessionSecretHash, 'sessionSecretHash');
    if (
      options.trustedProxyHops !== undefined &&
      (!Number.isSafeInteger(options.trustedProxyHops) || options.trustedProxyHops < 0)
    ) {
      throw new Error('trustedProxyHops must be a non-negative integer');
    }
    validatePositiveIntegerOption(options.maxBodyBytes, 'maxBodyBytes');
    validatePositiveIntegerOption(options.requestTimeoutMs, 'requestTimeoutMs');
    validatePositiveIntegerOption(options.maxConcurrentRequests, 'maxConcurrentRequests');
    validatePositiveIntegerOption(options.maxConcurrentStreams, 'maxConcurrentStreams');
    const origin = new URL(options.publicOrigin);
    if (
      origin.protocol !== 'https:' &&
      origin.hostname !== '127.0.0.1' &&
      origin.hostname !== 'localhost'
    ) {
      throw new Error('publicOrigin must use https');
    }
    this.options = {
      ...options,
      publicOrigin: origin.origin,
      maxBodyBytes: options.maxBodyBytes ?? 10 * 1024 * 1024,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 4,
      maxConcurrentStreams: options.maxConcurrentStreams ?? options.maxConcurrentRequests ?? 4,
      trustedProxyHops: options.trustedProxyHops ?? 0,
      expiresAt: options.expiresAt ?? new Date(8_640_000_000_000_000).toISOString(),
    };
    this.expiresAtMs = Date.parse(this.options.expiresAt);
    if (!Number.isFinite(this.expiresAtMs)) throw new Error('expiresAt must be an ISO timestamp');
    this.streams = new StreamRegistry<EdgeStream>({ maxBodyBytes: this.options.maxBodyBytes });
    this.websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: encodedPayloadLimit(this.options.maxBodyBytes),
    });
    // Application sockets carry the message itself rather than a base64 frame
    // around one, so their ceiling is the body bound with no envelope allowance.
    this.clientSockets = new WebSocketServer({
      noServer: true,
      maxPayload: this.options.maxBodyBytes,
      // `ws` would otherwise select the browser's first offered subprotocol on
      // its own authority. The only valid answer is the one the target gave,
      // which `openClientSocket` parks here for the duration of the handshake.
      handleProtocols: () => this.selectedProtocol,
    });
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch((error: unknown) => {
        if (!response.destroyed) {
          response.destroy(error instanceof Error ? error : new Error('preview request failed'));
        }
      });
    });
    this.server.on('upgrade', (request, socket, head) => {
      if (this.expired()) {
        socket.write('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url ?? '/', this.options.publicOrigin);
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (url.pathname === CONNECTOR_PATH) {
        if (!this.connectorAuthorized(request)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        this.websocketServer.handleUpgrade(request, socket, head, (client) =>
          this.attachConnector(client),
        );
        return;
      }
      // An application socket. A handshake cannot be answered with the login
      // redirect an ordinary request gets, so an unauthenticated one is refused
      // outright and the page that opened it sees a failed connection.
      if (!this.sessionAuthorized(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const connector = this.connector;
      if (!connector || connector.readyState !== WebSocket.OPEN) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // A WebSocket is long-lived by definition, so unlike an http exchange it
      // never passes through the request pool at all.
      if (this.activeStreams >= this.options.maxConcurrentStreams) {
        socket.write(
          'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n',
        );
        socket.destroy();
        return;
      }
      const headers = websocketRequestHeaders(request.headers);
      if (!validHeaders(headers, FORBIDDEN_REQUEST_HEADERS)) {
        socket.write('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // An offer that is not a list of distinct tokens can never be completed:
      // `ws` refuses it when this handshake is finally answered. Saying so now
      // costs nothing, where letting it through spends a dial on the target for
      // a socket that is already doomed.
      if (!validSubprotocolOffer(request.headers['sec-websocket-protocol'])) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.openClientSocket(
        { request, socket, head },
        connector,
        url.pathname + url.search,
        headers,
      );
    });
    const remaining = this.expiresAtMs - Date.now();
    this.expiryTimer =
      options.expiresAt === undefined || remaining <= 0
        ? undefined
        : setTimeout(() => {
            this.connector?.close(4003, 'share expired');
            this.resetAll(new Error('preview share expired'));
          }, remaining);
    this.expiryTimer?.unref?.();
  }

  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        const address = this.server.address();
        if (!address || typeof address === 'string')
          return reject(new Error('edge has no TCP address'));
        resolve(address.port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.connector?.close(1001, 'edge shutdown');
    this.resetAll(new Error('preview edge stopped'));
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
    this.websocketServer.close();
    this.clientSockets.close();
  }

  private attachConnector(client: WebSocket): void {
    if (this.connector) {
      this.resetAll(new Error('preview connector was replaced'));
      this.connector.close(4001, 'replaced by current connector');
    }
    this.connector = client;
    client.on('message', (data, binary) => {
      if (binary) return client.close(1003, 'binary frames are unsupported');
      let frame: unknown;
      try {
        frame = JSON.parse(rawDataText(data));
      } catch {
        return client.close(1007, 'invalid JSON');
      }
      if (!validStreamFrame(frame, this.options.maxBodyBytes)) {
        return client.close(1008, 'invalid frame');
      }
      this.applyFrame(client, frame);
    });
    client.once('close', () => {
      if (this.connector === client) {
        this.connector = undefined;
        this.resetAll(new Error('preview connector disconnected'));
      }
    });
  }

  /**
   * Applies one validated frame to its stream. Ordering faults that the previous
   * framing had to catch by hand — a body before its head, a second head, an end
   * that never began — are now decided by the registry, which knows the state of
   * both directions and answers with the reset code to send.
   */
  private applyFrame(client: WebSocket, frame: StreamFrame): void {
    const record = this.streams.get(frame.streamId);
    // Frames for a stream this side already dropped are ignored rather than
    // faulted. When the edge resets a stream — a reader that closed its tab, a
    // deadline that fired — the connector still has frames in flight for it, and
    // punishing those would tear down a connection over an ordinary race.
    if (!record) return;
    switch (frame.kind) {
      case 'stream.open': {
        // The connector only ever opens the reply direction of a stream the edge
        // started, and what that open carries depends on the channel: a status
        // line for `http`, the target's acceptance for `ws`.
        const reply: HttpResponseMeta | WsAcceptMeta | undefined =
          record.channel === 'http'
            ? isHttpResponseMeta(frame.meta)
              ? frame.meta
              : undefined
            : isWsAcceptMeta(frame.meta)
              ? frame.meta
              : undefined;
        if (!reply) return this.faultStream(client, frame.streamId, 'protocol_error');
        const result = this.streams.acceptOpen(frame.streamId, record.channel, record.context);
        if (!result.ok) return this.faultStream(client, frame.streamId, result.code);
        record.context.head(reply);
        return;
      }
      case 'stream.data': {
        const payload = Buffer.from(frame.payload, 'base64');
        const result = this.streams.acceptData(frame.streamId, frame.seq, payload.byteLength);
        if (!result.ok) return this.faultStream(client, frame.streamId, result.code);
        record.context.data(payload, frame.meta?.opcode);
        return;
      }
      case 'stream.end': {
        const result = this.streams.acceptEnd(frame.streamId);
        if (!result.ok) return this.faultStream(client, frame.streamId, result.code);
        record.context.end(frame.meta);
        return;
      }
      case 'stream.reset': {
        this.streams.reset(frame.streamId);
        record.context.fail(new Error(`preview stream reset: ${frame.code}`));
        return;
      }
    }
  }

  /**
   * Drops a stream and tells the peer why. A protocol error additionally closes
   * the connector: a peer known to violate the contract is still holding
   * whatever else it opened, so failing the one stream would leave the rest of
   * them attached to something that cannot be trusted to release them.
   */
  private faultStream(client: WebSocket, streamId: string, code: StreamResetCode): void {
    sendStreamFrame(client, { kind: 'stream.reset', streamId, code });
    const dropped = this.streams.reset(streamId);
    dropped?.context.fail(new Error(`preview stream reset: ${code}`));
    if (code === 'protocol_error') client.close(1008, 'invalid frame order');
  }

  /**
   * Dials the target for an application WebSocket and completes the browser's
   * handshake only once the target has accepted it.
   *
   * Answering the browser first would be simpler but wrong twice over: a target
   * that refuses the socket would surface as a connection that opened and then
   * closed rather than as one that failed, and the edge would have to invent a
   * subprotocol answer before knowing what the target selected — leaving the two
   * endpoints believing they agreed on different ones.
   */
  private openClientSocket(
    pending: { request: IncomingMessage; socket: Duplex; head: Buffer },
    connector: WebSocket,
    path: string,
    headers: Record<string, string>,
  ): void {
    const streamId = randomUUID();
    const offered = new Set(
      (pending.request.headers['sec-websocket-protocol'] ?? '')
        .toString()
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
    this.activeStreams += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.activeStreams -= 1;
    };
    // Until the accept arrives the browser has only a half-finished handshake,
    // so a failure is written to the raw socket as a status rather than sent as
    // a close frame the peer would not understand yet.
    let client: WebSocket | undefined;
    const refuse = (status: string): void => {
      release();
      this.streams.reset(streamId);
      if (!pending.socket.destroyed) {
        pending.socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        pending.socket.destroy();
      }
    };
    const dial = setTimeout(() => {
      sendStreamFrame(connector, { kind: 'stream.reset', streamId, code: 'timeout' });
      refuse('504 Gateway Timeout');
    }, this.options.requestTimeoutMs);
    dial.unref?.();
    const onClientGone = (): void => {
      if (!this.streams.get(streamId)) return;
      sendStreamFrame(connector, { kind: 'stream.reset', streamId, code: 'client_gone' });
      clearTimeout(dial);
      release();
      this.streams.reset(streamId);
    };
    pending.socket.once('close', onClientGone);

    this.streams.openOutbound(streamId, 'ws', {
      head: (meta) => {
        clearTimeout(dial);
        pending.socket.off('close', onClientGone);
        const selected = (meta as WsAcceptMeta).protocol;
        // A selection the client never offered is one the browser is required to
        // reject, so completing the handshake would only open a socket that dies
        // on arrival. Refused as a failed connection instead, which is the
        // honest report and the one the page can act on.
        if (selected !== undefined && !offered.has(selected)) {
          sendStreamFrame(connector, { kind: 'stream.reset', streamId, code: 'protocol_error' });
          return refuse('502 Bad Gateway');
        }
        // `handleProtocols` is consulted synchronously inside `handleUpgrade`,
        // so parking the target's selection here hands it to exactly this
        // handshake and nothing else.
        this.selectedProtocol = selected ?? false;
        try {
          this.clientSockets.handleUpgrade(
            pending.request,
            pending.socket,
            pending.head,
            (opened) => {
              client = opened;
              this.attachClientSocket(opened, connector, streamId, release);
            },
          );
        } finally {
          this.selectedProtocol = false;
        }
        // `handleUpgrade` runs its callback synchronously, and skips it entirely
        // when the handshake is malformed — a missing key, a version it does not
        // speak — answering the socket itself instead. That is the one path
        // where the target has accepted and yet no client exists, so the stream
        // is handed back here or its slot is held for the life of the share.
        if (!client) {
          release();
          this.streams.reset(streamId);
          sendStreamFrame(connector, { kind: 'stream.reset', streamId, code: 'client_gone' });
        }
      },
      data: (payload, opcode) => {
        if (!client || client.readyState !== WebSocket.OPEN) return;
        // Nothing can be paused on this side: the frames come off the connector,
        // which is shared with every other stream. A browser that will not read
        // is dropped instead of buffered, exactly as a response body is when its
        // backlog outgrows a frame.
        if (client.bufferedAmount > this.options.maxBodyBytes) {
          release();
          this.streams.reset(streamId);
          sendStreamFrame(connector, { kind: 'stream.reset', streamId, code: 'client_gone' });
          client.close(1011, 'preview stream backlog exceeded');
          return;
        }
        client.send(payload, { binary: opcode !== 'text' });
      },
      end: (meta) => {
        release();
        if (!client) return refuse('502 Bad Gateway');
        closeWebSocket(client, meta?.code, meta?.reason);
      },
      fail: () => {
        release();
        if (!client) return refuse('502 Bad Gateway');
        closeWebSocket(client, 1011, 'preview stream failed');
      },
    });
    sendStreamFrame(connector, {
      kind: 'stream.open',
      streamId,
      channel: 'ws',
      meta: { path, headers },
    });
  }

  /** Relays an accepted application WebSocket. By this point both directions of
   * the stream are open, so the socket is an ordinary two-way relay. */
  private attachClientSocket(
    client: WebSocket,
    connector: WebSocket,
    streamId: string,
    release: () => void,
  ): void {
    const settle = connectorBackpressure(
      client,
      connector,
      encodedPayloadLimit(this.options.maxBodyBytes),
    );
    client.on('message', (data: WebSocket.RawData, binary: boolean) => {
      const payload = rawDataBuffer(data);
      const seq = this.streams.nextOutboundSeq(streamId);
      if (seq === undefined) return;
      sendStreamFrame(
        connector,
        {
          kind: 'stream.data',
          streamId,
          seq,
          payload: payload.toString('base64'),
          meta: { opcode: binary ? 'binary' : 'text' },
        },
        settle,
      );
      settle();
    });
    client.once('close', (code: number, reason: Buffer) => {
      release();
      // Closing a WebSocket is bidirectional, so there is nothing left to
      // deliver either way: the half-close carries the peer's status onward and
      // the record goes with it. Frames still in flight land on an unknown
      // stream, which the receiving side ignores.
      if (!this.streams.get(streamId)) return;
      sendStreamFrame(connector, {
        kind: 'stream.end',
        streamId,
        ...closeMeta(code, reason),
      });
      this.streams.reset(streamId);
    });
  }

  /** Terminates every live stream. Used when the share expires, the edge stops,
   * or the connector goes away — nothing would ever complete these, and a
   * WebSocket left open would outlive the share it belongs to. */
  private resetAll(error: Error): void {
    for (const record of this.streams.drain()) record.context.fail(error);
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let counted = false;
    let streaming = false;
    try {
      if (this.expired()) {
        response.writeHead(410, { 'cache-control': 'no-store' });
        response.end('Preview share expired.');
        return;
      }
      const url = new URL(request.url ?? '/', this.options.publicOrigin);
      if (url.pathname === LOGIN_PATH) {
        await this.handleLogin(request, response);
        return;
      }
      if (!this.sessionAuthorized(request)) {
        response.writeHead(303, {
          location: `${LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`,
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }
      const method = request.method ?? 'GET';
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) {
        response.writeHead(405, {
          allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
          'content-type': 'text/plain; charset=utf-8',
        });
        response.end('Unsupported preview request method.');
        return;
      }
      const headers = filteredHeaders(request.headers);
      if (!validHeaders(headers, FORBIDDEN_REQUEST_HEADERS)) {
        response.writeHead(431, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Preview request headers are too large or invalid.');
        return;
      }
      const connector = this.connector;
      if (!connector || connector.readyState !== WebSocket.OPEN) {
        response.writeHead(503, {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': '2',
        });
        response.end('Preview connector is not available.');
        return;
      }
      if (this.activeRequests >= this.options.maxConcurrentRequests) {
        response.writeHead(503, {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': '1',
        });
        response.end('Preview request concurrency limit reached.');
        return;
      }
      this.activeRequests += 1;
      counted = true;
      const body = await readBody(
        request,
        this.options.maxBodyBytes,
        this.options.requestTimeoutMs,
      );
      if (this.expired()) throw new Error('preview share expired');
      const streamId = randomUUID();
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const settle = (finish: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          timer = undefined;
          this.streams.reset(streamId);
          response.off('close', onReaderGone);
          finish();
        };
        const abandon = (code: StreamResetCode, reason: string): void => {
          sendStreamFrame(connector, { kind: 'stream.reset', streamId, code });
          settle(() => reject(new Error(reason)));
        };
        const onReaderGone = (): void => {
          // The reader walked away. Without this the connector would keep pulling
          // from the target for a response nobody is reading. Attached before the
          // request goes out rather than at the response head: an abort while the
          // target is still working on the headers leaves exactly the same
          // orphaned upstream exchange, and `settle` detaches this on every
          // ordinary completion so a finished response cannot trigger it.
          abandon('client_gone', 'preview reader disconnected');
        };
        response.on('close', onReaderGone);
        let headArrived = false;
        timer = setTimeout(() => {
          // The deadline no longer ends an exchange that is making progress, it
          // reclassifies one. Every response is a stream now, so the head cannot
          // say whether this is a page load or a live feed — but outliving the
          // request deadline can, and it needs no guess about the content type.
          if (!headArrived) {
            abandon('timeout', 'preview request timed out');
            return;
          }
          // Long-lived exchanges leave the request pool so a stalled EventSource
          // cannot starve page loads, which means they need a ceiling of their
          // own rather than an unbounded second life.
          if (this.activeStreams >= this.options.maxConcurrentStreams) {
            abandon('concurrency_limit', 'preview stream concurrency limit reached');
            return;
          }
          timer = undefined;
          streaming = true;
          this.activeStreams += 1;
          this.activeRequests -= 1;
          counted = false;
        }, this.options.requestTimeoutMs);
        this.streams.openOutbound(streamId, 'http', {
          fail: (error) => settle(() => reject(error)),
          head: (meta) => {
            const { status, headers: responseHeaders } = meta as HttpResponseMeta;
            headArrived = true;
            response.writeHead(status, sanitizeResponseHeaders(responseHeaders));
            response.flushHeaders();
          },
          data: (payload) => {
            if (response.writableEnded) return;
            if (response.write(payload)) return;
            // The connector socket is shared with every other in-flight request,
            // so pausing it would let one slow reader stall the whole share.
            // Node buffers instead, and the runaway stream alone is dropped.
            if (response.writableLength <= this.options.maxBodyBytes) return;
            abandon('body_limit', 'preview reader fell too far behind');
          },
          end: () => {
            settle(() => {
              response.end();
              resolve();
            });
          },
        });
        sendStreamFrame(connector, {
          kind: 'stream.open',
          streamId,
          channel: 'http',
          meta: { method, path: url.pathname + url.search, headers },
        });
        // A zero-length body needs no frame of its own; the half-close below is
        // what tells the connector the request is complete either way.
        if (body.byteLength > 0) {
          const seq = this.streams.nextOutboundSeq(streamId);
          if (seq !== undefined) {
            sendStreamFrame(connector, {
              kind: 'stream.data',
              streamId,
              seq,
              payload: body.toString('base64'),
            });
          }
        }
        sendStreamFrame(connector, { kind: 'stream.end', streamId });
        this.streams.endOutbound(streamId);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'preview request failed';
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(message));
        return;
      }
      const status = message.includes('preview share expired')
        ? 410
        : message.includes('preview request too large')
          ? 413
          : message.includes('timed out')
            ? 504
            : message.includes('concurrency limit')
              ? 503
              : 502;
      response.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        ...(error instanceof RequestBodyError ? { connection: 'close' } : {}),
      });
      response.end(message, () => {
        if (error instanceof RequestBodyError) request.destroy();
      });
    } finally {
      if (counted) this.activeRequests -= 1;
      if (streaming) this.activeStreams -= 1;
    }
  }

  private expired(): boolean {
    return Date.now() >= this.expiresAtMs;
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? LOGIN_PATH, this.options.publicOrigin);
    if (request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
        'x-frame-options': 'DENY',
      });
      response.end(loginPage(url.searchParams.get('next') ?? '/'));
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, POST' });
      response.end();
      return;
    }
    if (this.loginVerifications >= 2) {
      response.writeHead(429, {
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': '1',
      });
      response.end('Too many concurrent PIN attempts.');
      return;
    }
    this.loginVerifications += 1;
    try {
      const client = this.loginClientIdentity(request);
      if (!client) {
        response.writeHead(400, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end('A valid trusted forwarding chain is required.');
        return;
      }
      const now = Date.now();
      for (const [identity, attempts] of this.loginFailures) {
        while (attempts[0] !== undefined && attempts[0] < now - 60_000) attempts.shift();
        if (attempts.length === 0) this.loginFailures.delete(identity);
      }
      if (!this.loginFailures.has(client) && this.loginFailures.size >= MAX_LOGIN_IDENTITIES) {
        response.writeHead(429, {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': '60',
        });
        response.end('PIN verification capacity reached.');
        return;
      }
      const failures = this.loginFailures.get(client) ?? [];
      if (failures.length >= 10) {
        response.writeHead(429, {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': '60',
        });
        response.end('Too many PIN attempts.');
        return;
      }
      failures.push(now);
      this.loginFailures.set(client, failures);
      const form = new URLSearchParams((await readBody(request, 8 * 1024, 5_000)).toString('utf8'));
      if (this.expired()) {
        response.writeHead(410, { 'cache-control': 'no-store' });
        response.end('Preview share expired.');
        return;
      }
      if (!(await verifyPreviewPin(form.get('pin') ?? '', this.options.pinHash))) {
        response.writeHead(401, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end('Invalid PIN.');
        return;
      }
      if (this.expired()) {
        response.writeHead(410, { 'cache-control': 'no-store' });
        response.end('Preview share expired.');
        return;
      }
      this.loginFailures.delete(client);
      const next = safeNext(form.get('next'), this.options.publicOrigin);
      response.writeHead(303, {
        location: next,
        'set-cookie': `${COOKIE_NAME}=${this.sessionValue()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
        'cache-control': 'no-store',
      });
      response.end();
    } finally {
      this.loginVerifications -= 1;
    }
  }

  private loginClientIdentity(request: IncomingMessage): string | undefined {
    if (this.options.trustedProxyHops > 0) {
      const forwarded = request.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
      const chain = value?.split(',').map((entry) => entry.trim()) ?? [];
      if (
        chain.length < this.options.trustedProxyHops ||
        chain.some((entry) => isIP(entry) === 0)
      ) {
        return undefined;
      }
      const client = chain.at(-this.options.trustedProxyHops);
      if (client) return `forwarded:${client}`;
      return undefined;
    }
    return `socket:${request.socket.remoteAddress ?? 'unknown'}`;
  }

  private connectorAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return false;
    return safeHashEquals(
      hashPreviewSecret(authorization.slice(7)),
      this.options.connectorTokenHash,
    );
  }

  private sessionAuthorized(request: IncomingMessage): boolean {
    const value = parseCookies(request.headers.cookie)[COOKIE_NAME];
    return value !== undefined && safeHashEquals(value, this.sessionValue());
  }

  private sessionValue(): string {
    return createHmac('sha256', this.options.sessionSecretHash)
      .update(`preview-session:${this.options.shareId}`)
      .digest('base64url');
  }
}

export class PreviewConnector {
  private readonly options: Required<PreviewConnectorOptions>;
  private readonly streams: StreamRegistry<ConnectorStream>;
  private socket: WebSocket | undefined;
  private disconnected: Promise<void> = Promise.resolve();
  private activeRequests = 0;
  private activeStreams = 0;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(options: PreviewConnectorOptions) {
    validatePositiveIntegerOption(options.maxBodyBytes, 'maxBodyBytes');
    validatePositiveIntegerOption(options.requestTimeoutMs, 'requestTimeoutMs');
    validatePositiveIntegerOption(options.maxConcurrentRequests, 'maxConcurrentRequests');
    validatePositiveIntegerOption(options.maxConcurrentStreams, 'maxConcurrentStreams');
    const edge = new URL(options.edgeUrl);
    if (!['ws:', 'wss:'].includes(edge.protocol)) throw new Error('edgeUrl must use ws or wss');
    if (edge.protocol !== 'wss:' && !isLoopbackHostname(edge.hostname)) {
      throw new Error('edgeUrl must use wss outside loopback development');
    }
    const target = new URL(options.targetOrigin);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('targetOrigin must use http or https');
    }
    if (
      target.pathname !== '/' ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    ) {
      throw new Error('targetOrigin must not contain credentials, path, query, or fragment');
    }
    this.options = {
      ...options,
      edgeUrl: edge.toString(),
      targetOrigin: target.origin,
      maxBodyBytes: options.maxBodyBytes ?? 10 * 1024 * 1024,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 4,
      maxConcurrentStreams: options.maxConcurrentStreams ?? options.maxConcurrentRequests ?? 4,
    };
    this.streams = new StreamRegistry<ConnectorStream>({
      maxBodyBytes: this.options.maxBodyBytes,
    });
  }

  connect(): Promise<void> {
    if (this.socket) return Promise.reject(new Error('preview connector is already connected'));
    return new Promise((resolve, reject) => {
      this.stopHeartbeat();
      const socket = new WebSocket(this.options.edgeUrl, {
        headers: { authorization: `Bearer ${this.options.connectorToken}` },
        maxPayload: encodedPayloadLimit(this.options.maxBodyBytes),
      });
      this.socket = socket;
      let opened = false;
      this.disconnected = new Promise((disconnected) => socket.once('close', () => disconnected()));
      socket.once('open', () => {
        opened = true;
        this.startHeartbeat(socket);
        resolve();
      });
      socket.once('error', (error) => {
        if (!opened) {
          if (this.socket === socket) this.socket = undefined;
          socket.terminate();
          reject(error);
        }
      });
      socket.once('close', () => {
        if (this.socket === socket) {
          this.stopHeartbeat();
          this.socket = undefined;
        }
        this.abandonAll();
        if (!opened) {
          reject(new Error('preview connector closed before opening'));
        }
      });
      socket.on('message', (data, binary) => this.handleMessage(socket, data, binary));
    });
  }

  waitForDisconnect(): Promise<void> {
    return this.disconnected;
  }

  close(): void {
    this.stopHeartbeat();
    this.socket?.close(1000, 'connector stopped');
  }

  private startHeartbeat(socket: WebSocket): void {
    let responsive = true;
    socket.on('pong', () => {
      responsive = true;
    });
    this.heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!responsive) {
        socket.terminate();
        return;
      }
      responsive = false;
      socket.ping();
    }, CONNECTOR_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private handleMessage(socket: WebSocket, data: WebSocket.RawData, binary: boolean): void {
    if (binary) {
      socket.close(1003, 'binary frames are unsupported');
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(rawDataText(data));
    } catch {
      socket.close(1007, 'invalid JSON');
      return;
    }
    if (!validStreamFrame(frame, this.options.maxBodyBytes)) {
      socket.close(1008, 'invalid frame');
      return;
    }
    this.applyFrame(socket, frame);
  }

  private applyFrame(socket: WebSocket, frame: StreamFrame): void {
    if (frame.kind === 'stream.open') {
      // A reused id would overwrite the live entry, so a later reset would abort
      // the wrong exchange and the first one's cleanup would drop the second's,
      // leaving an upstream stream nothing can stop.
      if (this.streams.get(frame.streamId)) {
        socket.close(1008, 'duplicate stream id');
        return;
      }
      if (frame.channel === 'ws') {
        if (!isWsOpenMeta(frame.meta)) {
          return this.faultStream(socket, frame.streamId, 'protocol_error');
        }
        if (this.activeStreams >= this.options.maxConcurrentStreams) {
          sendStreamFrame(socket, {
            kind: 'stream.reset',
            streamId: frame.streamId,
            code: 'concurrency_limit',
          });
          return;
        }
        this.openTargetSocket(socket, frame.streamId, frame.meta);
        return;
      }
      if (!isHttpRequestMeta(frame.meta)) {
        return this.faultStream(socket, frame.streamId, 'protocol_error');
      }
      if (this.activeRequests >= this.options.maxConcurrentRequests) {
        // Refused with a real status rather than a bare reset: nothing has been
        // sent yet, so the reader can still be told to retry instead of being
        // handed the generic failure a reset would surface as.
        sendErrorResponse(
          socket,
          frame.streamId,
          503,
          'Connector request concurrency limit reached.',
          this.options.maxBodyBytes,
        );
        return;
      }
      const context: ConnectorHttpStream = {
        channel: 'http',
        meta: frame.meta,
        chunks: [],
        cancelled: new AbortController(),
        counted: true,
        streaming: false,
        headSent: false,
      };
      this.activeRequests += 1;
      const result = this.streams.acceptOpen(frame.streamId, 'http', context);
      if (!result.ok) {
        this.activeRequests -= 1;
        return this.faultStream(socket, frame.streamId, result.code);
      }
      return;
    }
    // As on the edge, a frame for a stream this side already released lost a race
    // with its own teardown and is dropped rather than punished.
    const record = this.streams.get(frame.streamId);
    if (!record) return;
    switch (frame.kind) {
      case 'stream.data': {
        const payload = Buffer.from(frame.payload, 'base64');
        const result = this.streams.acceptData(frame.streamId, frame.seq, payload.byteLength);
        if (!result.ok) return this.faultStream(socket, frame.streamId, result.code);
        const context = record.context;
        if (context.channel === 'http') {
          context.chunks.push(payload);
          return;
        }
        // Nothing can legitimately arrive before the acceptance: the edge has
        // not completed its own handshake yet, so it has no client to relay for.
        // A peer that sent anyway would otherwise be handed an unbounded buffer
        // here by dialling a port that accepts connections and never answers.
        if (!context.open) return this.faultStream(socket, frame.streamId, 'protocol_error');
        // The connector socket is shared, so a target that stops reading cannot
        // be waited out without stalling every other stream. Its own backlog is
        // the bound, and the stream is dropped once it outgrows a frame.
        if (context.socket.bufferedAmount > this.options.maxBodyBytes) {
          return this.faultStream(socket, frame.streamId, 'upstream_error');
        }
        context.socket.send(payload, { binary: frame.meta?.opcode !== 'text' });
        return;
      }
      case 'stream.end': {
        const result = this.streams.acceptEnd(frame.streamId);
        if (!result.ok) return this.faultStream(socket, frame.streamId, result.code);
        const context = record.context;
        if (context.channel === 'ws') {
          // A WebSocket close is bidirectional, so a half-close has no analogue:
          // the peer is gone, and the target socket goes with it.
          if (context.open) closeWebSocket(context.socket, frame.meta?.code, frame.meta?.reason);
          // A dial the edge gave up on before the target answered: there is no
          // close status to carry, and the half-open connection goes away.
          else context.socket.terminate();
          return;
        }
        // The request is complete, so the exchange can go upstream.
        void this.relay(socket, frame.streamId, context);
        return;
      }
      case 'stream.reset': {
        const context = record.context;
        this.release(frame.streamId, context);
        if (context.channel === 'ws') context.socket.terminate();
        else context.cancelled.abort(new Error(`preview stream reset: ${frame.code}`));
        return;
      }
    }
  }

  private faultStream(socket: WebSocket, streamId: string, code: StreamResetCode): void {
    sendStreamFrame(socket, { kind: 'stream.reset', streamId, code });
    const dropped = this.streams.reset(streamId);
    if (dropped) {
      this.release(streamId, dropped.context);
      if (dropped.context.channel === 'ws') dropped.context.socket.terminate();
      else dropped.context.cancelled.abort(new Error(`preview stream reset: ${code}`));
    }
    if (code === 'protocol_error') socket.close(1008, 'invalid frame order');
  }

  /**
   * Dials the target for a `ws` stream. The edge has already completed its own
   * handshake, so a refusal here can only be reported as a close or a reset —
   * which is what a browser shows for any WebSocket that fails to connect.
   */
  private openTargetSocket(socket: WebSocket, streamId: string, meta: WsOpenMeta): void {
    const target = new URL(meta.path, this.options.targetOrigin);
    if (target.origin !== this.options.targetOrigin) {
      return this.faultStream(socket, streamId, 'protocol_error');
    }
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const { protocols, headers } = websocketDialHeaders(meta.headers);
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(target, protocols, {
        headers,
        maxPayload: this.options.maxBodyBytes,
        handshakeTimeout: this.options.requestTimeoutMs,
      });
    } catch {
      // A dial that cannot even be constructed is one stream's failure, not the
      // tunnel's: reset it and leave the connector's other streams running.
      return this.faultStream(socket, streamId, 'upstream_error');
    }
    const context: ConnectorWsStream = {
      channel: 'ws',
      socket: upstream,
      open: false,
      counted: false,
      streaming: true,
    };
    this.activeStreams += 1;
    this.streams.acceptOpen(streamId, 'ws', context);
    upstream.once('open', () => {
      context.open = true;
      // The acceptance opens the reply direction and carries the subprotocol the
      // target selected, which is the only answer the edge can honestly give the
      // browser waiting on its own handshake.
      this.streams.openOutbound(streamId, 'ws', context);
      sendStreamFrame(socket, {
        kind: 'stream.open',
        streamId,
        channel: 'ws',
        meta: upstream.protocol ? { protocol: upstream.protocol } : {},
      });
    });
    const settle = connectorBackpressure(
      upstream,
      socket,
      encodedPayloadLimit(this.options.maxBodyBytes),
    );
    upstream.on('message', (data: WebSocket.RawData, binary: boolean) => {
      const seq = this.streams.nextOutboundSeq(streamId);
      if (seq === undefined) return;
      sendStreamFrame(
        socket,
        {
          kind: 'stream.data',
          streamId,
          seq,
          payload: rawDataBuffer(data).toString('base64'),
          meta: { opcode: binary ? 'binary' : 'text' },
        },
        settle,
      );
      settle();
    });
    upstream.once('error', () => {
      const live = this.streams.get(streamId) !== undefined;
      this.release(streamId, context);
      if (live) sendStreamFrame(socket, { kind: 'stream.reset', streamId, code: 'upstream_error' });
    });
    upstream.once('close', (code: number, reason: Buffer) => {
      const live = this.streams.get(streamId) !== undefined;
      this.release(streamId, context);
      if (live) {
        sendStreamFrame(socket, { kind: 'stream.end', streamId, ...closeMeta(code, reason) });
      }
    });
  }

  /**
   * Drops every stream this connection was serving, on disconnect. Nothing can
   * complete them once the edge is gone: an http relay would go on pulling a
   * response nobody will ever read, and a `ws` upstream would stay open for a
   * browser with no path back to it. Their slots would stay taken too, so a
   * connector that reconnected often enough would end up unable to serve
   * anything at all.
   */
  private abandonAll(): void {
    for (const record of this.streams.drain()) {
      const context = record.context;
      this.release(record.streamId, context);
      if (context.channel === 'ws') context.socket.terminate();
      else context.cancelled.abort(new Error('preview connector disconnected'));
    }
  }

  /** Releases a stream's slot. Idempotent through the context's own flags, since
   * the registry forgets a stream as soon as both directions end — which happens
   * before the relay's cleanup runs. */
  private release(streamId: string, context: ConnectorStream): void {
    this.streams.reset(streamId);
    if (context.counted) {
      this.activeRequests -= 1;
      context.counted = false;
    }
    if (context.streaming) {
      this.activeStreams -= 1;
      context.streaming = false;
    }
  }

  private async relay(
    socket: WebSocket,
    streamId: string,
    context: ConnectorHttpStream,
  ): Promise<void> {
    let deadline: NodeJS.Timeout | undefined;
    const disconnected = new AbortController();
    const abortOnDisconnect = (): void => disconnected.abort();
    socket.once('close', abortOnDisconnect);
    try {
      const target = new URL(context.meta.path, this.options.targetOrigin);
      if (target.origin !== this.options.targetOrigin) throw new Error('target origin changed');
      const expired = new AbortController();
      // Before the head the deadline is a timeout: `maxBodyBytes` caps size, not
      // time, so a target that never answers would hold a slot indefinitely.
      // After it, the same instant is instead where an exchange that is still
      // running proves itself long-lived and moves to the stream pool — a body
      // whose last byte never comes is the case this framing exists for.
      deadline = setTimeout(() => {
        if (!context.headSent) {
          expired.abort(new Error('preview request timed out'));
          return;
        }
        if (this.activeStreams >= this.options.maxConcurrentStreams) {
          context.failureCode = 'concurrency_limit';
          context.cancelled.abort(new Error('preview stream concurrency limit reached'));
          return;
        }
        context.streaming = true;
        this.activeStreams += 1;
        if (context.counted) {
          this.activeRequests -= 1;
          context.counted = false;
        }
      }, this.options.requestTimeoutMs);
      const init: RequestInit = {
        method: context.meta.method,
        headers: context.meta.headers,
        redirect: 'manual',
        signal: AbortSignal.any([expired.signal, context.cancelled.signal, disconnected.signal]),
      };
      if (context.meta.method !== 'GET' && context.meta.method !== 'HEAD') {
        init.body = Buffer.concat(context.chunks);
      }
      const upstream = await fetch(target, init);
      // A declared `content-length` is deliberately not compared against
      // `maxBodyBytes`. The response is sliced into frames and relayed, never
      // accumulated, so its total says nothing about memory — refusing on it
      // would reject a large asset while the identical bytes sent chunked went
      // through. What memory there is lives in the send backlog, which
      // `relayBody` bounds directly.
      context.headSent = true;
      this.streams.openOutbound(streamId, 'http', context);
      sendStreamFrame(socket, {
        kind: 'stream.open',
        streamId,
        channel: 'http',
        meta: {
          status: upstream.status,
          headers: filteredResponseHeaders(upstream.headers, target),
        },
      });
      await this.relayBody(socket, streamId, context, upstream);
    } catch (error) {
      // Once the head is on the wire no status can be sent any more, so an
      // abnormal reset is the only honest signal left — ending cleanly would
      // report a truncated body as a complete one.
      if (context.headSent) {
        sendStreamFrame(socket, {
          kind: 'stream.reset',
          streamId,
          code: context.failureCode ?? 'upstream_error',
        });
      } else {
        sendErrorResponse(
          socket,
          streamId,
          502,
          error instanceof Error ? error.message : 'connector request failed',
          this.options.maxBodyBytes,
        );
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      socket.off('close', abortOnDisconnect);
      this.release(streamId, context);
    }
  }

  private async relayBody(
    socket: WebSocket,
    streamId: string,
    context: ConnectorHttpStream,
    upstream: Response,
  ): Promise<void> {
    const chunkLimit = this.options.maxBodyBytes;
    const backlogLimit = encodedPayloadLimit(chunkLimit);
    // Every abnormal exit is recorded rather than thrown: the caller would
    // otherwise send a second, contradicting frame after this one.
    let failed = false;
    try {
      const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
        upstream.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        if (socket.readyState !== WebSocket.OPEN) {
          failed = true;
          break;
        }
        // The edge stops reading when its reader stalls; if the backlog still
        // grows past a frame, the stream is dropped rather than buffered.
        if (socket.bufferedAmount > backlogLimit) {
          await reader.cancel('preview stream backlog exceeded');
          failed = true;
          break;
        }
        for (let offset = 0; offset < value.byteLength; offset += chunkLimit) {
          // Rechecked per slice, not just per upstream chunk: one oversized read
          // would otherwise enqueue every slice at once and blow the bound above.
          if (socket.bufferedAmount > backlogLimit) {
            failed = true;
            break;
          }
          const seq = this.streams.nextOutboundSeq(streamId);
          if (seq === undefined) {
            failed = true;
            break;
          }
          sendStreamFrame(socket, {
            kind: 'stream.data',
            streamId,
            seq,
            payload: Buffer.from(value.subarray(offset, offset + chunkLimit)).toString('base64'),
          });
        }
        if (failed) {
          await reader.cancel('preview stream dropped');
          break;
        }
      }
    } catch {
      failed = true;
    } finally {
      if (failed) {
        sendStreamFrame(socket, {
          kind: 'stream.reset',
          streamId,
          code: context.failureCode ?? 'upstream_error',
        });
      } else {
        sendStreamFrame(socket, { kind: 'stream.end', streamId });
        this.streams.endOutbound(streamId);
      }
    }
  }
}

function readBody(request: IncomingMessage, limit: number, timeoutMs?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const fail = (error: Error, closeConnection = false): void => {
      cleanup();
      request.pause();
      reject(closeConnection ? new RequestBodyError(error.message) : error);
    };
    const onData = (value: Buffer | string): void => {
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > limit) {
        fail(new Error('preview request too large'), true);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => fail(error);
    const onAborted = (): void => fail(new Error('preview request aborted'));
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => fail(new Error('preview request body timed out'), true), timeoutMs);
    }
  });
}

function rawDataText(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function sendStreamFrame(socket: WebSocket, frame: StreamFrame, onFlush?: () => void): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(frame), () => {
      // Disconnects are handled by the connector reconnect loop.
      onFlush?.();
    });
  } catch {
    // The socket can close between the ready-state check and send.
  }
}

/**
 * Holds one `ws` source to the pace of the tunnel it feeds.
 *
 * The connector socket carries every stream at once, so a peer that produces
 * faster than the tunnel drains cannot be answered by pausing the connector —
 * that would stall every other stream with it, and letting the queue grow
 * instead is how one loud socket exhausts the process. The source is paused
 * instead, which stops reading exactly the connection running ahead and lets
 * TCP carry the pressure back to it, and resumes once the backlog has drained.
 */
function connectorBackpressure(source: WebSocket, connector: WebSocket, limit: number): () => void {
  let paused = false;
  return () => {
    const congested = connector.bufferedAmount > limit;
    if (congested === paused) return;
    paused = congested;
    if (congested) source.pause();
    else source.resume();
  };
}

/**
 * Answers a stream with a complete one-shot response. Used where the connector
 * refuses an exchange before ever reaching the target: a bare `stream.reset`
 * would surface to the reader as a generic failure, losing the status and the
 * retry hint that make the refusal actionable.
 */
function sendErrorResponse(
  socket: WebSocket,
  streamId: string,
  status: number,
  message: string,
  maxBodyBytes: number,
): void {
  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
  if (status === 503) headers['retry-after'] = '1';
  sendStreamFrame(socket, {
    kind: 'stream.open',
    streamId,
    channel: 'http',
    meta: { status, headers },
  });
  sendStreamFrame(socket, {
    kind: 'stream.data',
    streamId,
    seq: 0,
    // Truncated to the frame budget: an explanation that overflows it is refused
    // as an invalid frame and costs the peer the whole connection, which is a
    // far worse answer than a clipped sentence.
    payload: Buffer.from(message).subarray(0, maxBodyBytes).toString('base64'),
  });
  sendStreamFrame(socket, { kind: 'stream.end', streamId });
}

function rawDataBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/** Close codes a peer never sends on the wire: 1005 means "no status" and 1006
 * "closed abnormally", both synthesised locally. Forwarding one would make the
 * far side send a code it is forbidden to send. */
/** A local close carries a status the peer never sent — 1005 for "no status",
 * 1006 for an abnormal close — so it is dropped rather than invented onward. */
function closeMeta(code: number, reason: Buffer): { meta?: { code: number; reason?: string } } {
  if (!sendableCloseCode(code)) return {};
  const text = reason.toString('utf8');
  return { meta: { code, ...(text ? { reason: text } : {}) } };
}

function closeWebSocket(socket: WebSocket, code: number | undefined, reason?: string): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  if (code === undefined || !sendableCloseCode(code)) {
    socket.close();
    return;
  }
  socket.close(code, reason);
}

/**
 * Handshake headers are per-hop: the key, version and extensions describe the
 * connection the edge already accepted, and reusing them for the dial to the
 * target would either be rejected or negotiate an extension nobody asked for.
 * `sec-websocket-protocol` survives, because it is the application's own choice
 * and the connector re-offers it to the target.
 */
const WEBSOCKET_HOP_HEADERS = new Set([
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
]);

function websocketRequestHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const result = filteredHeaders(headers);
  for (const name of WEBSOCKET_HOP_HEADERS) delete result[name];
  return result;
}

/** The `Sec-WebSocket-Protocol` grammar: a list of distinct tokens, or absent. */
function validSubprotocolOffer(value: string | string[] | undefined): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const entry of value.split(',')) {
    const token = entry.trim();
    if (!isSubprotocolToken(token) || seen.has(token)) return false;
    seen.add(token);
  }
  return seen.size > 0;
}

function websocketDialHeaders(headers: Record<string, string>): {
  protocols: string[];
  headers: Record<string, string>;
} {
  const forwarded = { ...headers };
  const offered = new Set<string>();
  for (const [name, value] of Object.entries(forwarded)) {
    const lowered = name.toLowerCase();
    if (lowered === 'sec-websocket-protocol') {
      // A `Set` of tokens, not the raw split: `ws` throws synchronously from its
      // constructor on a duplicate or non-token entry, and this list comes
      // straight off a client's handshake, so the naive split hands a caller a
      // way to raise an exception inside the connector's frame handler.
      for (const entry of value.split(',')) {
        const token = entry.trim();
        if (isSubprotocolToken(token)) offered.add(token);
      }
      delete forwarded[name];
    } else if (WEBSOCKET_HOP_HEADERS.has(lowered)) {
      delete forwarded[name];
    }
  }
  return { protocols: [...offered], headers: forwarded };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function filteredHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP.has(name) ||
      name === 'host' ||
      name === 'cookie' ||
      name === 'forwarded' ||
      name.startsWith('x-forwarded-')
    )
      continue;
    result[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

function filteredResponseHeaders(headers: Headers, requestUrl: URL): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (
      !HOP_BY_HOP.has(name) &&
      name !== 'set-cookie' &&
      name !== 'content-encoding' &&
      name !== 'content-length'
    )
      result[name] = value;
  });
  const location = result.location;
  if (location) {
    try {
      const target = new URL(location, requestUrl);
      if (target.origin === requestUrl.origin) {
        result.location = target.pathname + target.search + target.hash;
      } else {
        delete result.location;
      }
    } catch {
      delete result.location;
    }
  }
  return result;
}

function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!HOP_BY_HOP.has(name) && name !== 'set-cookie' && name !== 'content-length')
      result[name] = value;
  }
  result['cache-control'] ??= 'no-store';
  return result;
}

function parseCookies(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of value?.split(';') ?? []) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function safeNext(value: string | null, publicOrigin: string): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  const target = new URL(value, publicOrigin);
  return target.origin === publicOrigin ? target.pathname + target.search + target.hash : '/';
}

function safeHashEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function validateHash(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256 hex digest`);
}

function validatePositiveIntegerOption(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function validatePinHash(value: string): void {
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(value)) {
    throw new Error('pinHash must be a Verity scrypt digest');
  }
}

async function verifyPreviewPin(pin: string, encoded: string): Promise<boolean> {
  const [, salt, expected] = encoded.split(':');
  if (!salt || !expected || !/^\d{6,12}$/.test(pin)) return false;
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(pin, salt, 32, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  return safeHashEquals(derived.toString('hex'), expected);
}

function loginPage(next: string): string {
  const escaped = next.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Development preview</title><style>body{font:16px system-ui;max-width:28rem;margin:12vh auto;padding:1.5rem}input,button{box-sizing:border-box;width:100%;padding:.8rem;margin:.4rem 0}small{color:#555}</style></head><body><h1>Development preview</h1><p>This temporary environment may change or disappear without notice.</p><form method="post" action="${LOGIN_PATH}"><input type="hidden" name="next" value="${escaped}"><label>PIN<input name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" required autofocus></label><button type="submit">Open preview</button></form><small>Do not enter production, customer, or business-critical data.</small></body></html>`;
}
