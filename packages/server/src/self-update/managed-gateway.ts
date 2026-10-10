import {
  switchRequestDiagnostic,
  createSwitchDiagnosticBudget,
} from '../switch-request-diagnostic.js';
import { randomUUID } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type OutgoingHttpHeaders,
} from 'node:http';
import { createServer, type Server } from 'node:http';
import {
  createSecureServer,
  constants as http2Constants,
  type Http2SecureServer,
  Http2ServerRequest,
  Http2ServerResponse,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from 'node:http2';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';

import { MCP_GATEWAY_APPROVAL_TIMEOUT_MS } from '../mcp-gateway-timeout.js';
import {
  MANAGED_CLIENT_IDENTITY_HEADER,
  signManagedClientIdentity,
} from '../managed-client-identity.js';

import {
  MANAGED_BROWSER_ORIGIN_HEADER,
  signManagedBrowserOrigin,
} from '../managed-browser-origin.js';

type GatewayRequest = IncomingMessage | Http2ServerRequest;
type GatewayResponse = ServerResponse | Http2ServerResponse;
type GatewayServer = Server | Http2SecureServer;

function writeGatewayHead(
  response: GatewayResponse,
  status: number,
  headers: OutgoingHttpHeaders = {},
): void {
  if (response instanceof Http2ServerResponse) response.writeHead(status, headers);
  else response.writeHead(status, headers);
}

interface Destroyable {
  destroy(error?: Error): void;
}

interface CloseableDestroyable extends Destroyable {
  once(event: 'close', listener: () => void): this;
}

/**
 * Must stay well inside the slack the Updater's drain request allows on top of
 * the drain itself (`drainManagedGateway`), or the Updater gives up on a drain
 * the Gateway is about to report as done.
 */
export const DEFAULT_DRAIN_CLOSE_GRACE_MS = 2_000;

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ManagedGatewayBackend {
  readonly host: string;
  readonly publicPort: number;
  readonly internalPort: number;
}

export interface ManagedGatewayConfig {
  /** Fixed metadata and validated opaque diagnostic tokens only; never URLs, raw headers, addresses or error messages. */
  readonly log?: (event: Record<string, string | number>) => void;
  readonly tls?: { readonly key: string | Buffer; readonly cert: string | Buffer };
  readonly publicHost?: string;
  readonly publicPort: number;
  /** Local HTTP/WS preview ingress ports, forwarded unchanged to the selected Server. */
  readonly localPreviewPorts?: readonly number[];
  readonly internalHost?: string;
  readonly internalPort: number;
  readonly backend: ManagedGatewayBackend;
  /** Exact backend host identities admitted by this deployment. */
  readonly allowedBackendHosts: readonly string[];
  /** Admit updater-owned immutable generation identities in addition to exact hosts. */
  readonly allowManagedServerGenerations?: boolean;
  /** Durable backend selection, on the Gateway-owned control volume. */
  readonly backendStatePath?: string;
  readonly requestTimeoutMs?: number;
  /** How long a drain waits for force-closed connections to report closing. */
  readonly drainCloseGraceMs?: number;
  /** Shared only with the managed Server; authenticates the original socket peer. */
  readonly clientIdentitySecret?: Buffer;
}

export interface ManagedGatewayStatus {
  readonly maintenance: boolean;
  readonly draining: boolean;
  readonly backend: ManagedGatewayBackend;
  readonly activeRequests: number;
  readonly upgradedConnections: number;
}

export interface ManagedGatewayRuntime {
  readonly publicPort: number;
  readonly internalPort: number;
  /** Point-in-time view of what the gateway is routing and whether it is open. */
  status(): ManagedGatewayStatus;
  /** Reject new work while existing requests and upgrades drain. */
  enterMaintenance(): void;
  /** Atomically select one backend for both public and internal routes. */
  switchBackend(backend: ManagedGatewayBackend): void;
  leaveMaintenance(): void;
  /** Wait for in-flight work, then close remaining upgraded connections at the deadline. */
  drain(timeoutMs: number): Promise<{ forced: number }>;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Connection-listed headers are hop-by-hop too, including arbitrary extension names. */
function forwardedHeaders(headers: IncomingMessage['headers']): IncomingMessage['headers'] {
  const connection = headers.connection?.split(',').map((name) => name.trim().toLowerCase()) ?? [];
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !name.startsWith(':') && !HOP_BY_HOP.has(name) && !connection.includes(name),
    ),
  );
}

// An ACP tool call parks this HTTP request while the user decides. Keep the
// ordinary proxy deadline tight, but give this one internal endpoint enough
// time to cover the approval window and return the tool result afterwards.
const INTERNAL_MCP_TIMEOUT_MS = MCP_GATEWAY_APPROVAL_TIMEOUT_MS + 30_000;
const INTERNAL_MCP_PATHS = new Set(['/internal/mcp', '/internal/control-plane/mcp']);
// A share.create response may take 120 seconds; the proxy must outlive it so
// the app receives the actual result instead of an ambiguous 502.
const PUBLIC_PREVIEW_CREATE_TIMEOUT_MS = 150_000;

function publicRequestTimeout(
  method: string | undefined,
  url: string | undefined,
  defaultTimeoutMs: number,
): number {
  const path = (url ?? '/').split('?', 1)[0] ?? '/';
  return method === 'POST' && /^\/sessions\/[^/]+\/public-static-shares$/.test(path)
    ? Math.max(defaultTimeoutMs, PUBLIC_PREVIEW_CREATE_TIMEOUT_MS)
    : defaultTimeoutMs;
}

function internalRequestTimeout(url: string | undefined, defaultTimeoutMs: number): number {
  const path = (url ?? '/').split('?', 1)[0] ?? '/';
  return INTERNAL_MCP_PATHS.has(path)
    ? Math.max(defaultTimeoutMs, INTERNAL_MCP_TIMEOUT_MS)
    : defaultTimeoutMs;
}

/** Unknown OpenSSL errors remain opaque: messages can contain peer-controlled data. */
function tlsFailureReason(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case 'ERR_SSL_HTTP_REQUEST':
      return 'plaintext_http';
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return 'wrong_tls_version';
    case 'ERR_SSL_NO_SHARED_CIPHER':
      return 'no_shared_cipher';
    case 'ERR_TLS_HANDSHAKE_TIMEOUT':
      return 'handshake_timeout';
    case 'ECONNRESET':
      return 'connection_reset';
    default:
      return 'tls_error';
  }
}

function validPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535;
}

function isManagedServerGenerationHost(host: string): boolean {
  const match = /^verity-managed-server-g([1-9][0-9]{0,9})$/.exec(host);
  return match !== null && Number(match[1]) <= 2_147_483_647;
}

function validateBackend(
  backend: ManagedGatewayBackend,
  allowedBackendHosts: readonly string[],
  allowManagedServerGenerations: boolean = false,
): void {
  if (
    !validPort(backend.publicPort) ||
    !validPort(backend.internalPort) ||
    backend.publicPort === 0 ||
    backend.internalPort === 0
  )
    throw new Error('managed gateway backend ports must be valid');
  if (
    backend.host.length === 0 ||
    /[\s/:\\]/.test(backend.host) ||
    (!allowedBackendHosts.includes(backend.host) &&
      !(allowManagedServerGenerations && isManagedServerGenerationHost(backend.host)))
  )
    throw new Error('managed gateway backend host is not allowlisted');
}

function validateConfig(config: ManagedGatewayConfig): void {
  if (
    !validPort(config.publicPort) ||
    !validPort(config.internalPort) ||
    !validPort(config.backend.publicPort) ||
    !validPort(config.backend.internalPort)
  ) {
    throw new Error('managed gateway ports must be valid');
  }
  const previewPorts = config.localPreviewPorts ?? [];
  if (
    new Set(previewPorts).size !== previewPorts.length ||
    previewPorts.some(
      (port) =>
        !validPort(port) ||
        port === 0 ||
        port === config.publicPort ||
        port === config.internalPort,
    )
  ) {
    throw new Error('managed gateway preview ports must be distinct valid ports');
  }
  validateBackend(config.backend, config.allowedBackendHosts, config.allowManagedServerGenerations);
  if (config.requestTimeoutMs !== undefined && config.requestTimeoutMs <= 0) {
    throw new Error('managed gateway request timeout must be positive');
  }
  if (
    config.drainCloseGraceMs !== undefined &&
    (!Number.isSafeInteger(config.drainCloseGraceMs) || config.drainCloseGraceMs < 0)
  ) {
    throw new Error('managed gateway drain close grace must be a non-negative integer');
  }
}

function readPersistedBackend(config: ManagedGatewayConfig): ManagedGatewayBackend {
  if (config.backendStatePath === undefined) return config.backend;
  let raw: string;
  try {
    raw = readFileSync(config.backendStatePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return config.backend;
    throw error;
  }
  const value = JSON.parse(raw) as Partial<ManagedGatewayBackend>;
  const backend = {
    host: value.host,
    publicPort: value.publicPort,
    internalPort: value.internalPort,
  } as ManagedGatewayBackend;
  validateBackend(backend, config.allowedBackendHosts, config.allowManagedServerGenerations);
  return backend;
}

function persistBackend(path: string | undefined, backend: ManagedGatewayBackend): void {
  if (path === undefined) return;
  const temporary = `${path}.next`;
  const file = openSync(temporary, 'w', 0o600);
  try {
    chmodSync(temporary, 0o600);
    writeFileSync(file, `${JSON.stringify(backend)}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function publicPathAllowed(url: string | undefined): boolean {
  const path = (url ?? '/').split('?', 1)[0] ?? '/';
  return path !== '/internal' && !path.startsWith('/internal/');
}

function proxyHttp(
  request: GatewayRequest,
  response: GatewayResponse,
  backend: ManagedGatewayBackend,
  port: number,
  timeoutMs: number,
  upstreamRequests: Set<Destroyable>,
  upstreamSockets: Set<Socket>,
  backendClientIdentitySecret: Buffer | undefined,
  diagnosticLog?: (event: Record<string, string | number>) => void,
): void {
  const diagnostic = switchRequestDiagnostic(request.method, request.url, request.headers);
  const started = performance.now();
  const fields: Record<string, string | number> | undefined =
    diagnosticLog && diagnostic
      ? {
          event: 'session-switch-http',
          ...diagnostic,
          receivedAt: Date.now(),
          httpVersion: request.httpVersion,
        }
      : undefined;
  const mark = (phase: string): void => {
    if (fields) fields[phase] = Math.round((performance.now() - started) * 1000) / 1000;
  };
  let reported = false;
  const report = (outcome: string): void => {
    if (!fields || reported) return;
    reported = true;
    mark('downstreamCompletedMs');
    diagnosticLog?.({ ...fields, outcome, statusCode: response.statusCode });
  };
  response.once('finish', () => report('finished'));
  response.once('close', () => report('closed'));
  const headers = forwardedHeaders(request.headers);
  delete headers['x-verity-switch-request'];
  delete headers['x-verity-switch-kind'];
  if (diagnostic) {
    headers['x-verity-switch-request'] = diagnostic.diagnosticRequestId;
    headers['x-verity-switch-kind'] = diagnostic.kind;
  }
  for (const header of HOP_BY_HOP) delete headers[header];
  delete headers[MANAGED_CLIENT_IDENTITY_HEADER];
  delete headers[MANAGED_BROWSER_ORIGIN_HEADER];
  if (backendClientIdentitySecret !== undefined) {
    const origin = `${'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http'}://${request.headers.host ?? ''}`;
    const signedOrigin = signManagedBrowserOrigin(backendClientIdentitySecret, {
      origin,
      method: request.method ?? 'GET',
      url: request.url ?? '/',
    });
    if (signedOrigin !== undefined) headers[MANAGED_BROWSER_ORIGIN_HEADER] = signedOrigin;
  }
  if (backendClientIdentitySecret !== undefined) {
    headers[MANAGED_CLIENT_IDENTITY_HEADER] = signManagedClientIdentity(
      backendClientIdentitySecret,
      {
        address: request.socket.remoteAddress ?? 'unknown',
        method: request.method ?? 'GET',
        url: request.url ?? '/',
      },
    );
  }
  headers.host = `${backend.host}:${String(port)}`;
  mark('forwardMs');
  const upstream = httpRequest(
    {
      host: backend.host,
      port,
      method: request.method,
      path: request.url,
      headers,
      timeout: timeoutMs,
    },
    (upstreamResponse) => {
      mark('upstreamResponseMs');
      if (fields) fields.upstreamReusedSocket = upstream.reusedSocket ? 1 : 0;
      upstreamResponse.once('end', () => mark('upstreamEndMs'));
      upstreamResponse.once('aborted', () => response.destroy());
      upstreamResponse.once('error', () => response.destroy());
      const responseHeaders = forwardedHeaders(upstreamResponse.headers);
      for (const header of HOP_BY_HOP) delete responseHeaders[header];
      writeGatewayHead(response, upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );
  upstreamRequests.add(upstream);
  upstream.once('close', () => upstreamRequests.delete(upstream));
  upstream.once('finish', () => mark('upstreamRequestFinishMs'));
  upstream.once('socket', (socket) => {
    mark('socketAssignedMs');
    trackUpstreamSocket(socket, upstreamSockets);
  });
  upstream.once('timeout', () => upstream.destroy(new Error('managed gateway upstream timeout')));
  upstream.once('error', () => {
    if (!response.headersSent)
      writeGatewayHead(response, 502, { 'content-type': 'application/json' });
    response.end('{"error":"upstream unavailable"}');
  });
  request.once('aborted', () => upstream.destroy());
  response.once('close', () => {
    if (!response.writableFinished) upstream.destroy();
  });
  request.pipe(upstream);
}

/**
 * Track one upstream socket exactly once, however many requests ride on it.
 *
 * `httpRequest` here runs on Node's global agent, which keeps connections alive
 * by default, so one socket serves request after request to the same backend.
 * Registering the removal listener per REQUEST therefore piled listeners onto a
 * socket that outlives all of them — eleven proxied requests were enough for
 * `MaxListenersExceededWarning: 11 close listeners added to [Socket]`, and the
 * count only ever grew. The Set already made the tracking idempotent; the
 * listener has to be made idempotent with it.
 */
function trackUpstreamSocket(socket: Socket, upstreamSockets: Set<Socket>): void {
  if (upstreamSockets.has(socket)) return;
  upstreamSockets.add(socket);
  socket.once('close', () => upstreamSockets.delete(socket));
}

function rejectUpgrade(socket: Duplex, status: 404 | 502 | 503): void {
  const phrase =
    status === 404 ? 'Not Found' : status === 503 ? 'Service Unavailable' : 'Bad Gateway';
  socket.end(
    `HTTP/1.1 ${String(status)} ${phrase}\r\n` + 'Connection: close\r\nContent-Length: 0\r\n\r\n',
  );
}

/** Immediately abort a pending connect; reset only an established upstream. */
export function closeManagedGatewayUpstreamSocket(
  socket: Pick<Socket, 'connecting' | 'destroyed' | 'writable' | 'destroy' | 'resetAndDestroy'>,
): void {
  if (socket.connecting || socket.destroyed || !socket.writable) socket.destroy();
  else socket.resetAndDestroy();
}

function proxyUpgrade(
  request: IncomingMessage,
  downstream: Duplex,
  head: Buffer,
  backend: ManagedGatewayBackend,
  port: number,
  timeoutMs: number,
  upstreamRequests: Set<Destroyable>,
  upstreamSockets: Set<Socket>,
  backendClientIdentitySecret: Buffer | undefined,
): void {
  const headers = { ...request.headers };
  delete headers[MANAGED_CLIENT_IDENTITY_HEADER];
  delete headers[MANAGED_BROWSER_ORIGIN_HEADER];
  if (backendClientIdentitySecret !== undefined) {
    const origin = `${'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http'}://${request.headers.host ?? ''}`;
    const signedOrigin = signManagedBrowserOrigin(backendClientIdentitySecret, {
      origin,
      method: request.method ?? 'GET',
      url: request.url ?? '/',
    });
    if (signedOrigin !== undefined) headers[MANAGED_BROWSER_ORIGIN_HEADER] = signedOrigin;
  }
  if (backendClientIdentitySecret !== undefined) {
    headers[MANAGED_CLIENT_IDENTITY_HEADER] = signManagedClientIdentity(
      backendClientIdentitySecret,
      {
        address: request.socket.remoteAddress ?? 'unknown',
        method: request.method ?? 'GET',
        url: request.url ?? '/',
      },
    );
  }
  const upstream = httpRequest({
    host: backend.host,
    port,
    method: request.method,
    path: request.url,
    headers: { ...headers, host: `${backend.host}:${String(port)}` },
    timeout: timeoutMs,
  });
  upstreamRequests.add(upstream);
  upstream.once('close', () => upstreamRequests.delete(upstream));
  upstream.once('socket', (socket) => trackUpstreamSocket(socket, upstreamSockets));
  upstream.once('upgrade', (response, socket, upstreamHead) => {
    upstreamRequests.delete(upstream);
    trackUpstreamSocket(socket, upstreamSockets);
    const status = response.statusCode ?? 101;
    const lines = [`HTTP/1.1 ${String(status)} ${response.statusMessage ?? 'Switching Protocols'}`];
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined)
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
    downstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length > 0) downstream.write(upstreamHead);
    if (head.length > 0) socket.write(head);
    socket.pipe(downstream).pipe(socket);
  });
  const fail = (): void => rejectUpgrade(downstream, 502);
  upstream.once('timeout', () => upstream.destroy());
  upstream.once('error', fail);
  upstream.end();
}

function listen(server: GatewayServer, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: GatewayServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

/** Start the unprivileged, fixed-backend managed front door. This foundation has
 * no control mutation surface: changing generations is a later journaled slice. */
export async function startManagedGateway(
  config: ManagedGatewayConfig,
): Promise<ManagedGatewayRuntime> {
  validateConfig(config);
  const timeoutMs = config.requestTimeoutMs ?? 30_000;
  const drainCloseGraceMs = config.drainCloseGraceMs ?? DEFAULT_DRAIN_CLOSE_GRACE_MS;
  const publicSockets = new Set<Socket>();
  const internalSockets = new Set<Socket>();
  const upgradedSockets = new Set<Duplex>();
  const upstreamRequests = new Set<Destroyable>();
  const upstreamSockets = new Set<Socket>();
  const activeHttpSockets = new Map<Socket, number>();
  const sessions = new Set<ServerHttp2Session>();
  const activeStreams = new Set<ServerHttp2Stream>();
  const liveStreams = new Set<ServerHttp2Stream>();
  const admitSwitchDiagnostic = createSwitchDiagnosticBudget();
  let activeRequests = 0;
  let maintenance = false;
  let draining = false;
  let backend = readPersistedBackend(config);
  const unavailable = (response: GatewayResponse): void => {
    writeGatewayHead(response, 503, {
      'content-type': 'application/json',
      ...(response instanceof Http2ServerResponse ? {} : { connection: 'close' }),
    });
    response.end('{"error":"server maintenance"}');
  };
  const route = (
    request: GatewayRequest,
    response: GatewayResponse,
    port: (value: ManagedGatewayBackend) => number,
    requestTimeoutMs: number = timeoutMs,
  ): void => {
    if (maintenance) return unavailable(response);
    activeRequests += 1;
    if (request instanceof Http2ServerRequest) activeStreams.add(request.stream);
    else activeHttpSockets.set(request.socket, (activeHttpSockets.get(request.socket) ?? 0) + 1);
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      activeRequests -= 1;
      if (request instanceof Http2ServerRequest) {
        activeStreams.delete(request.stream);
        return;
      }
      const remaining = (activeHttpSockets.get(request.socket) ?? 1) - 1;
      if (remaining === 0) activeHttpSockets.delete(request.socket);
      else activeHttpSockets.set(request.socket, remaining);
    };
    response.once('finish', done);
    response.once('close', done);
    const selected = backend;
    proxyHttp(
      request,
      response,
      selected,
      port(selected),
      requestTimeoutMs,
      upstreamRequests,
      upstreamSockets,
      config.clientIdentitySecret,
      config.log &&
        switchRequestDiagnostic(request.method, request.url, request.headers) &&
        admitSwitchDiagnostic()
        ? config.log
        : undefined,
    );
  };
  const tlsDiagnostics = new WeakMap<
    Socket,
    { connection: string; peerPort: number; probes: number }
  >();
  // HTTP/2 exposes a socket proxy, so object identity differs from secureConnection.
  const peerDiagnostics = new Map<
    string,
    { connection: string; peerPort: number; probes: number }
  >();
  const diagnostic = (socket: Socket) => {
    const peer = `${socket.localAddress}:${socket.localPort}:${socket.remoteAddress}:${socket.remotePort}`;
    let value = tlsDiagnostics.get(socket) ?? peerDiagnostics.get(peer);
    if (value === undefined) {
      // The port is only a best-effort local join with the connector's localPort;
      // NAT and port reuse prevent it from being an end-to-end identity.
      value = { connection: randomUUID(), peerPort: socket.remotePort ?? 0, probes: 0 };
      tlsDiagnostics.set(socket, value);
      peerDiagnostics.set(peer, value);
      const started = Date.now();
      const context = value;
      socket.once('close', () => {
        peerDiagnostics.delete(peer);
        config.log?.({
          event: 'gateway.tls',
          action: 'closed',
          connection: context.connection,
          peerPort: context.peerPort,
          durationMs: Date.now() - started,
          // These are Node TLSSocket counters, not opaque relay frame totals.
          receivedBytes: socket.bytesRead,
          sentBytes: socket.bytesWritten,
        });
      });
    }
    return value;
  };
  const publicHandler = (request: GatewayRequest, response: GatewayResponse): void => {
    if (request instanceof Http2ServerRequest) {
      const authority = request.headers[':authority'];
      const host = request.headers.host;
      if (
        typeof authority !== 'string' ||
        !authority ||
        (host !== undefined && host !== authority)
      ) {
        writeGatewayHead(response, 400);
        response.end();
        return;
      }
      request.headers.host = authority;
      if (request.method === 'CONNECT') {
        writeGatewayHead(response, 405);
        response.end();
        return;
      }
    }
    if (
      config.log !== undefined &&
      config.tls !== undefined &&
      request.method === 'GET' &&
      request.url?.split('?', 1)[0] === '/healthz'
    ) {
      const context = diagnostic(request.socket);
      // Keep-alive probes must not turn one connection into an unbounded log source.
      if (context.probes++ < 4) {
        const started = Date.now();
        const fields = {
          event: 'gateway.health_probe',
          connection: context.connection,
          peerPort: context.peerPort,
        };
        config.log({ ...fields, action: 'received' });
        let reported = false;
        const report = (action: string) => {
          if (reported) return;
          reported = true;
          config.log?.({
            ...fields,
            action,
            status: response.statusCode,
            durationMs: Date.now() - started,
          });
        };
        response.once('finish', () => report('completed'));
        response.once('close', () => report('closed'));
      }
    }

    if (!publicPathAllowed(request.url)) {
      writeGatewayHead(response, 404);
      response.end();
      return;
    }
    route(
      request,
      response,
      (value) => value.publicPort,
      publicRequestTimeout(request.method, request.url, timeoutMs),
    );
  };
  const publicServer =
    config.tls === undefined
      ? createServer(publicHandler)
      : createSecureServer(
          {
            key: config.tls.key,
            cert: config.tls.cert,
            allowHTTP1: true,
            settings: {
              maxConcurrentStreams: 16,
              maxHeaderListSize: 16 * 1024,
              enableConnectProtocol: false,
            },
          },
          publicHandler,
        );
  if (config.tls !== undefined) {
    publicServer.on('stream', (stream: ServerHttp2Stream, headers: IncomingMessage['headers']) => {
      liveStreams.add(stream);
      const session = stream.session;
      stream.once('close', () => {
        liveStreams.delete(stream);
        if (session && !session.destroyed) session.setTimeout(60_000);
      });
      stream.on('error', () => undefined);
      if (headers[':method'] === 'CONNECT' && !stream.headersSent) {
        stream.respond({ ':status': 405 });
        stream.end();
      }
    });
    publicServer.on('session', (session: ServerHttp2Session) => {
      sessions.add(session);
      session.on('error', () => undefined);
      session.once('close', () => sessions.delete(session));
      session.setTimeout(60_000, () => {
        if (![...liveStreams].some((stream) => stream.session === session)) session.close();
      });
    });
  }
  if (config.tls !== undefined && config.log !== undefined) {
    publicServer.on('secureConnection', (socket: TLSSocket) => {
      const context = diagnostic(socket);
      config.log?.({
        event: 'gateway.tls',
        action: 'secure',
        connection: context.connection,
        peerPort: context.peerPort,
      });
    });
    publicServer.on('tlsClientError', (error: NodeJS.ErrnoException, socket: TLSSocket) => {
      const context = diagnostic(socket);
      config.log?.({
        event: 'gateway.tls',
        action: 'failed',
        reason: tlsFailureReason(error),
        connection: context.connection,
        peerPort: context.peerPort,
      });
    });
  }
  const internalServer = createServer((request, response) =>
    route(
      request,
      response,
      (value) => value.internalPort,
      internalRequestTimeout(request.url, timeoutMs),
    ),
  );
  publicServer.on('connection', (socket: Socket) => {
    publicSockets.add(socket);
    socket.once('close', () => publicSockets.delete(socket));
  });
  internalServer.on('connection', (socket: Socket) => {
    internalSockets.add(socket);
    socket.once('close', () => internalSockets.delete(socket));
  });
  publicServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!publicPathAllowed(request.url)) return rejectUpgrade(socket, 404);
    if (maintenance) return rejectUpgrade(socket, 503);
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    const selected = backend;
    proxyUpgrade(
      request,
      socket,
      head,
      selected,
      selected.publicPort,
      timeoutMs,
      upstreamRequests,
      upstreamSockets,
      config.clientIdentitySecret,
    );
  });
  internalServer.on('upgrade', (request, socket, head) => {
    if (maintenance) return rejectUpgrade(socket, 503);
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    const selected = backend;
    proxyUpgrade(
      request,
      socket,
      head,
      selected,
      selected.internalPort,
      timeoutMs,
      upstreamRequests,
      upstreamSockets,
      config.clientIdentitySecret,
    );
  });

  let publicPort: number;
  try {
    publicPort = await listen(publicServer, config.publicHost ?? '127.0.0.1', config.publicPort);
  } catch (error) {
    await closeServer(publicServer, publicSockets).catch(() => undefined);
    throw error;
  }
  let internalPort: number;
  try {
    internalPort = await listen(
      internalServer,
      config.internalHost ?? '127.0.0.1',
      config.internalPort,
    );
  } catch (error) {
    await closeServer(publicServer, publicSockets);
    throw error;
  }
  // Preserve HTTP Host, streaming and WebSocket upgrades without buffering bodies.
  // The destination is always the selected, allowlisted Server on this fixed port.
  const previewServers: ReturnType<typeof createTcpServer>[] = [];
  const closePreviews = async (): Promise<void> => {
    await Promise.all(
      previewServers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  };
  try {
    for (const port of config.localPreviewPorts ?? []) {
      const server = createTcpServer((socket) => {
        if (maintenance) {
          socket.destroy();
          return;
        }
        upgradedSockets.add(socket);
        socket.once('close', () => upgradedSockets.delete(socket));
        socket.on('error', () => undefined);
        const upstream = connect({ host: backend.host, port });
        upstreamSockets.add(upstream);
        upstream.once('close', () => {
          upstreamSockets.delete(upstream);
          socket.destroy();
        });
        upstream.on('error', () => socket.destroy());
        socket.once('close', () => upstream.destroy());
        socket.pipe(upstream).pipe(socket);
      });
      previewServers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, config.publicHost ?? '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    }
  } catch (error) {
    for (const socket of upgradedSockets) socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await Promise.all([
      closePreviews(),
      closeServer(publicServer, publicSockets),
      closeServer(internalServer, internalSockets),
    ]);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    publicPort,
    internalPort,
    status: () => ({
      maintenance,
      draining,
      backend: { ...backend },
      activeRequests,
      upgradedConnections: upgradedSockets.size,
    }),
    enterMaintenance: () => {
      maintenance = true;
    },
    switchBackend: (next) => {
      if (!maintenance) throw new Error('managed gateway backend switch requires maintenance');
      if (draining) throw new Error('managed gateway backend switch cannot overlap drain');
      validateBackend(next, config.allowedBackendHosts, config.allowManagedServerGenerations);
      // Persist first: after a crash, routing to the requested generation is
      // safer than acknowledging a switch that a restart silently forgets.
      try {
        persistBackend(config.backendStatePath, next);
      } catch (error) {
        // rename(2) is the commit point. If the following directory fsync fails,
        // reconcile memory with whichever complete record is now visible before
        // reporting failure, so recovery observes the same route as a restart.
        backend = { ...readPersistedBackend(config) };
        throw error;
      }
      backend = { ...next };
    },
    leaveMaintenance: () => {
      if (draining) throw new Error('managed gateway cannot leave maintenance while draining');
      maintenance = false;
    },
    drain: async (drainTimeoutMs) => {
      if (!maintenance) throw new Error('managed gateway drain requires maintenance');
      if (draining) throw new Error('managed gateway drain already in progress');
      if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0)
        throw new Error('managed gateway drain timeout must be non-negative');
      draining = true;
      try {
        const deadline = Date.now() + drainTimeoutMs;
        while ((activeRequests > 0 || upgradedSockets.size > 0) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const forcedSockets = new Set<Duplex>([...upgradedSockets, ...activeHttpSockets.keys()]);
        const forcedStreams = [...activeStreams];
        const forced = forcedSockets.size + forcedStreams.length;
        const sockets = new Set<CloseableDestroyable>([
          ...forcedSockets,
          ...upstreamSockets,
          ...forcedStreams,
        ]);
        const unclosed = new Set(sockets);
        const closed = [...sockets].map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once('close', () => {
                unclosed.delete(socket);
                resolve();
              });
            }),
        );
        for (const stream of forcedStreams) stream.close(http2Constants.NGHTTP2_CANCEL);
        for (const request of upstreamRequests) request.destroy();
        for (const socket of forcedSockets) socket.destroy();
        for (const socket of upstreamSockets) closeManagedGatewayUpstreamSocket(socket);
        // Bounded: drain holds the serialized control channel, so waiting on a
        // 'close' that never comes would wedge every later Updater instruction —
        // leaving maintenance included — and keep the Gateway answering 503.
        if (!(await settlesWithin(Promise.all(closed), drainCloseGraceMs))) {
          // A stream's close() asks nghttp2 for an RST it may never get to send;
          // destroy() tears the stream down locally regardless.
          for (const socket of unclosed) socket.destroy();
          config.log?.({ event: 'gateway.drain', action: 'close-timeout', pending: unclosed.size });
        }
        return { forced };
      } finally {
        draining = false;
      }
    },
    close: () => {
      for (const session of sessions) session.destroy();
      for (const request of upstreamRequests) request.destroy();
      for (const socket of upgradedSockets) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      return (closing ??= Promise.all([
        closePreviews(),
        closeServer(publicServer, publicSockets),
        closeServer(internalServer, internalSockets),
      ]).then(() => undefined));
    },
  };
}
