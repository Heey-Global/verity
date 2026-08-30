import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import {
  createConnection,
  createServer as createNetServer,
  type Server,
  type Socket,
} from 'node:net';
import type { Duplex } from 'node:stream';

export const BROKER_SOCKET_PATH = '/run/verity-relay/broker/broker.sock';
export const CLAUDE_SOCKET_PATH = '/run/verity-relay/claude/claude.sock';
export const CODEX_SOCKET_PATH = '/run/verity-relay/codex/codex.sock';
export const BROKER_PORT = 8080;
export const CLAUDE_PORT = 8443;
export const CODEX_PORT = 8444;

/**
 * Every route the project-bound internal listener terminates. The relay is the only
 * hop between a Sandbox and that socket, so a route missing here is unreachable from
 * the Sandbox no matter how the Server is composed — which is how the MCP gateway
 * shipped dark. Keep in sync with `PROJECT_UDS_ROUTES` in
 * `packages/server/src/internal-listener.ts`; a Server test fails on drift.
 */
export const BROKER_RELAY_ROUTES: ReadonlySet<string> = new Set([
  'POST /internal/git/sign',
  'POST /internal/github/token',
  'POST /internal/project/memory',
  // The loopback MCP gateway (ADR 0014 D1) — an ACP agent's only path to the brokered
  // secret tools, authenticated with the per-turn bearer in `authorization`.
  'POST /internal/mcp',
  // Streamable HTTP clients open a GET stream for server-initiated messages once the
  // handshake completes. The gateway has none to send and answers 405, which the transport
  // reads as "no stream here" and drops. Rejecting the GET at the relay instead would answer
  // 404, which the same transport reports as a connection error on every ACP turn.
  'GET /internal/mcp',
]);
/**
 * Routes the Server does not answer from its own state but parks on an operator decision.
 * `POST /internal/mcp` carries a brokered tool call: the Server holds the request open on
 * the permission card until the operator decides it (`Conductor.requestExternalPermission`,
 * which has no deadline of its own), so the call lasts as long as the card is on screen —
 * a duration the broker profile below, written for sub-second git-sign and token calls,
 * cannot express.
 *
 * Without this split all three broker reapers fire while the card is still unanswered: the
 * downstream socket's idle timer, the upstream request timeout, and the absolute deadline,
 * each at `requestTimeoutMs`. Measured from a Sandbox, every brokered tool call then failed
 * as a relay connection error fifteen seconds in, while the Server went on waiting for a
 * decision it could no longer deliver.
 *
 * The GET half of the same route is deliberately absent: it answers 405 at once.
 */
export const BROKER_DECISION_ROUTES: ReadonlySet<string> = new Set(['POST /internal/mcp']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const ACCEPTED_REQUEST_HEADERS = new Set([
  'accept',
  // The three headers `fetch` adds on its own. An MCP client reaches the gateway through
  // `fetch`, so rejecting them would fail `initialize` itself — the allowlist is meant to
  // stop a caller from steering the relay, not to hold callers to hand-written requests.
  'accept-encoding',
  'accept-language',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
  // The MCP Streamable HTTP client sends this on every request after `initialize`. The
  // gateway ignores the value — it negotiates the version in the `initialize` body — but
  // rejecting the header would leave the gateway reachable and unusable: the handshake
  // would pass and the first `tools/list` would come back 400.
  'mcp-protocol-version',
  'sec-fetch-mode',
  'transfer-encoding',
  'user-agent',
]);
/**
 * Tolerated from the caller, dropped on the way upstream. `accept-encoding` is the one
 * that matters: a compressed answer would be counted against `maxResponseBytes` in its
 * compressed size, so the cap would stop bounding what the Sandbox actually receives.
 * The other two say nothing a broker route should act on.
 */
const CLIENT_ONLY_REQUEST_HEADERS = new Set([
  'accept-encoding',
  'accept-language',
  'sec-fetch-mode',
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  // What a 405 owes the caller: which methods the route does take.
  'allow',
  'content-length',
  'content-type',
  'retry-after',
]);
const trackedConnections = new WeakMap<HttpServer | Server, Set<Socket>>();

export interface RelayLimits {
  maxBodyBytes: number;
  maxResponseBytes: number;
  maxConnections: number;
  /** In-flight budget for {@link BROKER_DECISION_ROUTES}, held apart from `maxConnections`. */
  maxDecisionRequests: number;
  requestTimeoutMs: number;
  /** Upstream deadline for {@link BROKER_DECISION_ROUTES}. */
  decisionTimeoutMs: number;
  headersTimeoutMs: number;
  idleTimeoutMs: number;
}

export const RELAY_LIMITS: Readonly<RelayLimits> = Object.freeze({
  maxBodyBytes: 1_100_000,
  maxResponseBytes: 1_100_000,
  maxConnections: 8,
  // A parked call holds its slot for as long as the operator takes to answer, so it gets a
  // budget of its own: pending permission cards can never starve git-sign, nor the reverse.
  maxDecisionRequests: 8,
  requestTimeoutMs: 15_000,
  // Turn-sized, on the same scale as CLAUDE_RELAY_LIMITS.idleTimeoutMs: long enough that a
  // card answered at human speed still returns its answer, bounded so a card nobody answers
  // eventually releases the slot. The Server's own park has no deadline, so a call cut off
  // here leaves a card that stays decidable but whose answer no longer reaches the Sandbox —
  // which is why the ceiling is minutes rather than seconds.
  decisionTimeoutMs: 10 * 60 * 1_000,
  headersTimeoutMs: 5_000,
  idleTimeoutMs: 15_000,
});

export type ClaudeRelayLimits = Pick<RelayLimits, 'maxConnections' | 'idleTimeoutMs'>;

// The Claude tunnel carries inference streams, not short broker requests: a socket stays
// silent for as long as the model thinks. The idle reaper is kept, but on a turn-sized
// scale matching DEFAULT_AGENT_GATEWAY_SHUTDOWN_GRACE_MS, and with room for one stream
// per parallel agent rather than the broker's per-request cap.
export const CLAUDE_RELAY_LIMITS: Readonly<ClaudeRelayLimits> = Object.freeze({
  maxConnections: 64,
  idleTimeoutMs: 10 * 60 * 1_000,
});

export interface BrokerRelayOptions {
  socketPath?: string;
  limits?: Partial<RelayLimits>;
}

export interface StartedRelay {
  readonly brokerPort: number;
  readonly claudePort: number;
  readonly codexPort: number;
  close(): Promise<void>;
}

export function createBrokerRelayServer(options: BrokerRelayOptions = {}): HttpServer {
  const limits = { ...RELAY_LIMITS, ...options.limits };
  validateLimits(limits);
  const socketPath = options.socketPath ?? BROKER_SOCKET_PATH;
  const connections = new Set<Socket>();
  let inFlightRequests = 0;
  let inFlightDecisions = 0;
  const server = createHttpServer(
    { maxHeaderSize: 16 * 1024, requireHostHeader: true },
    (request, response) => {
      response.shouldKeepAlive = false;
      // Classified before the allowlist check, so the request is accounted against the
      // budget it is actually going to spend.
      const parked = BROKER_DECISION_ROUTES.has(`${request.method ?? ''} ${request.url ?? ''}`);
      const inFlight = parked ? inFlightDecisions : inFlightRequests;
      const budget = parked ? limits.maxDecisionRequests : limits.maxConnections;
      if (inFlight >= budget) {
        drainAndReject(request, response, 503, 'relay busy');
        return;
      }
      if (parked) inFlightDecisions += 1;
      else inFlightRequests += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (parked) {
          inFlightDecisions -= 1;
          request.socket.setTimeout(limits.idleTimeoutMs);
        } else {
          inFlightRequests -= 1;
        }
      };
      response.once('finish', release);
      response.once('close', release);
      void relayBrokerRequest(request, response, socketPath, limits, parked);
    },
  );
  trackedConnections.set(server, connections);
  // Both budgets can be spent at once: a parked brokered call must not consume the TCP
  // connection a git-sign needs, or the split above would be undone one layer down.
  server.maxConnections = limits.maxConnections + limits.maxDecisionRequests;
  // Bounds only the receipt of a request (the slowloris guard), never the wait for its
  // response, so a parked call is unaffected and this stays on the short profile.
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = Math.min(limits.idleTimeoutMs, limits.requestTimeoutMs);
  server.on('connection', (socket) => trackSocket(connections, socket, limits.idleTimeoutMs));
  server.on('connect', (_request, socket) => rejectRawSocket(socket));
  server.on('upgrade', (_request, socket) => rejectRawSocket(socket));
  server.on('checkContinue', (_request, response) => {
    response.writeHead(417, { connection: 'close', 'content-type': 'application/json' });
    response.end('{"error":"expectation failed"}');
  });
  server.once('close', () => destroySockets(connections));
  return server;
}

export function createClaudeRelayServer(
  socketPath = CLAUDE_SOCKET_PATH,
  limits: ClaudeRelayLimits = CLAUDE_RELAY_LIMITS,
): Server {
  const connections = new Set<Socket>();
  const server = createNetServer((downstream) => {
    trackSocket(connections, downstream, limits.idleTimeoutMs);
    const upstream = createConnection({ path: socketPath });
    trackSocket(connections, upstream, limits.idleTimeoutMs);
    downstream.once('error', () => upstream.destroy());
    upstream.once('error', () => downstream.destroy());
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  trackedConnections.set(server, connections);
  server.maxConnections = limits.maxConnections;
  server.once('close', () => destroySockets(connections));
  return server;
}

export async function startRelay(
  options: {
    host?: string;
    brokerPort?: number;
    claudePort?: number;
    brokerSocketPath?: string;
    claudeSocketPath?: string;
    codexPort?: number;
    codexSocketPath?: string;
  } = {},
): Promise<StartedRelay> {
  const host = options.host ?? '0.0.0.0';
  const broker = createBrokerRelayServer(
    options.brokerSocketPath === undefined ? {} : { socketPath: options.brokerSocketPath },
  );
  const claude = createClaudeRelayServer(options.claudeSocketPath);
  const codex = createClaudeRelayServer(options.codexSocketPath ?? CODEX_SOCKET_PATH);
  try {
    await listen(broker, options.brokerPort ?? BROKER_PORT, host);
    await listen(claude, options.claudePort ?? CLAUDE_PORT, host);
    await listen(codex, options.codexPort ?? CODEX_PORT, host);
  } catch (error) {
    await Promise.allSettled([closeServer(broker), closeServer(claude), closeServer(codex)]);
    throw error;
  }
  return {
    brokerPort: boundPort(broker),
    claudePort: boundPort(claude),
    codexPort: boundPort(codex),
    async close(): Promise<void> {
      await Promise.all([closeServer(broker), closeServer(claude), closeServer(codex)]);
    },
  };
}

async function relayBrokerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  socketPath: string,
  limits: RelayLimits,
  parked: boolean,
): Promise<void> {
  try {
    const method = request.method ?? '';
    const path = request.url ?? '';
    if (
      !path.startsWith('/') ||
      path.includes('?') ||
      !BROKER_RELAY_ROUTES.has(`${method} ${path}`)
    ) {
      drainAndReject(request, response, 404, 'not found');
      return;
    }
    if (hasUnsafeHeaders(request)) {
      drainAndReject(request, response, 400, 'invalid headers');
      return;
    }
    const declaredLength = parseContentLength(request.headers['content-length']);
    if (declaredLength !== undefined && declaredLength > limits.maxBodyBytes) {
      drainAndReject(request, response, 413, 'request too large');
      return;
    }
    const body = await readBounded(request, limits.maxBodyBytes);
    // The idle reaper counts silence, and a request waiting on a permission card is silent
    // by definition. Lift it only now: until the body is in, silence is a stalled sender
    // rather than a pending decision, and the short profile is the right guard for that.
    // `server.requestTimeout` bounds receipt either way; both are restored on release.
    //
    // The reprieve runs one short broker profile past the upstream deadline, so the two
    // reapers cannot race: the deadline always fires first and the caller is told 502,
    // rather than having the connection pulled out from under it at the same instant.
    if (parked) request.socket.setTimeout(limits.decisionTimeoutMs + limits.requestTimeoutMs);
    await forwardBrokerRequest(
      response,
      socketPath,
      method,
      path,
      request.headers,
      body,
      limits,
      parked ? limits.decisionTimeoutMs : limits.requestTimeoutMs,
    );
  } catch (error) {
    // `destroyed` covers the caller that hung up first: the failure it would be told about
    // is its own, and writing a status onto a dead response is how a proxy turns a client
    // disconnect into an unhandled write error of its own.
    if (response.headersSent || response.destroyed) {
      response.destroy();
      return;
    }
    const tooLarge = error instanceof RelayLimitError;
    response.writeHead(tooLarge ? 413 : 502, {
      connection: 'close',
      'content-type': 'application/json',
    });
    response.end(tooLarge ? '{"error":"request too large"}' : '{"error":"broker unavailable"}');
  }
}

function forwardBrokerRequest(
  response: ServerResponse,
  socketPath: string,
  method: string,
  path: string,
  headers: IncomingHttpHeaders,
  body: Buffer,
  limits: RelayLimits,
  upstreamTimeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      response.off('close', onClientGone);
      if (error === undefined) resolve();
      else reject(error);
    };
    // A parked call outlives most things, the Sandbox that made it included. Once the caller
    // is gone there is nobody left to hand the answer to, so the upstream request is dropped
    // rather than held open to its deadline.
    const onClientGone = (): void => {
      if (!response.writableEnded) upstream.destroy(new Error('relay client gone'));
    };
    const upstream = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: forwardedRequestHeaders(headers, body.length),
        timeout: upstreamTimeoutMs,
      },
      (upstreamResponse) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        upstreamResponse.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limits.maxResponseBytes) {
            upstreamResponse.destroy(new RelayLimitError());
            return;
          }
          chunks.push(chunk);
        });
        upstreamResponse.once('end', () => {
          response.writeHead(upstreamResponse.statusCode ?? 502, {
            ...responseHeaders(upstreamResponse.headers),
            connection: 'close',
          });
          response.end(Buffer.concat(chunks));
          settle();
        });
        upstreamResponse.once('error', (error) => settle(error));
      },
    );
    // Unref'd: a parked call's deadline is minutes long, and a timer that outlives the
    // listener would hold the event loop open for the rest of it. The listening server is
    // what keeps the process alive while a call is genuinely in flight.
    const deadline = setTimeout(
      () => upstream.destroy(new Error('broker deadline exceeded')),
      upstreamTimeoutMs,
    ).unref();
    upstream.once('timeout', () => upstream.destroy(new Error('broker idle timeout')));
    upstream.once('error', (error) => settle(error));
    response.once('close', onClientGone);
    upstream.end(body);
  });
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  bodyLength: number,
): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = { 'content-length': String(bodyLength) };
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name) ||
      CLIENT_ONLY_REQUEST_HEADERS.has(name) ||
      name === 'host' ||
      name === 'content-length'
    )
      continue;
    forwarded[name] = value;
  }
  return forwarded;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && FORWARDED_RESPONSE_HEADERS.has(name)) forwarded[name] = value;
  }
  return forwarded;
}

function hasUnsafeHeaders(request: IncomingMessage): boolean {
  if (request.headers.upgrade !== undefined || request.headers.expect !== undefined) return true;
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    if (!ACCEPTED_REQUEST_HEADERS.has(name)) return true;
    if (values !== undefined && values.length !== 1) return true;
    if (
      name === 'connection' &&
      (values?.[0] ?? '')
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .some((token) => token !== 'close' && token !== 'keep-alive')
    )
      return true;
  }
  return false;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new RelayLimitError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RelayLimitError();
  return parsed;
}

function readBounded(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        request.off('data', onData);
        request.resume();
        reject(new RelayLimitError());
        return;
      }
      chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.once('error', reject);
    request.once('aborted', () => reject(new Error('request aborted')));
  });
}

function drainAndReject(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  error: string,
): void {
  request.resume();
  response.writeHead(status, { connection: 'close', 'content-type': 'application/json' });
  response.end(JSON.stringify({ error }));
}

function trackSocket(connections: Set<Socket>, socket: Socket, idleTimeoutMs: number): void {
  connections.add(socket);
  socket.setTimeout(idleTimeoutMs, () => socket.destroy());
  socket.once('close', () => connections.delete(socket));
}

function rejectRawSocket(socket: Duplex): void {
  socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

function destroySockets(connections: Set<Socket>): void {
  for (const socket of connections) socket.destroy();
  connections.clear();
}

function validateLimits(limits: RelayLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid relay limit: ${name}`);
  }
}

function listen(server: HttpServer | Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: HttpServer | Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    destroySockets(trackedConnections.get(server) ?? new Set());
    server.close(() => resolve());
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
}

function boundPort(server: HttpServer | Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('relay has no TCP address');
  return address.port;
}

class RelayLimitError extends Error {}
