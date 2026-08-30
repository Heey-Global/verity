import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';

import { MCP_GATEWAY_APPROVAL_TIMEOUT_MS } from '../mcp-gateway.js';
import {
  MANAGED_CLIENT_IDENTITY_HEADER,
  signManagedClientIdentity,
} from '../managed-client-identity.js';

interface Destroyable {
  destroy(error?: Error): void;
}

interface CloseableDestroyable extends Destroyable {
  once(event: 'close', listener: () => void): this;
}

export interface ManagedGatewayBackend {
  readonly host: string;
  readonly publicPort: number;
  readonly internalPort: number;
}

export interface ManagedGatewayConfig {
  readonly tls?: { readonly key: string | Buffer; readonly cert: string | Buffer };
  readonly publicHost?: string;
  readonly publicPort: number;
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
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// An ACP tool call parks this HTTP request while the user decides. Keep the
// ordinary proxy deadline tight, but give this one internal endpoint enough
// time to cover the approval window and return the tool result afterwards.
const INTERNAL_MCP_TIMEOUT_MS = MCP_GATEWAY_APPROVAL_TIMEOUT_MS + 30_000;
const INTERNAL_MCP_PATHS = new Set(['/internal/mcp', '/internal/control-plane/mcp']);

function internalRequestTimeout(url: string | undefined, defaultTimeoutMs: number): number {
  const path = (url ?? '/').split('?', 1)[0] ?? '/';
  return INTERNAL_MCP_PATHS.has(path)
    ? Math.max(defaultTimeoutMs, INTERNAL_MCP_TIMEOUT_MS)
    : defaultTimeoutMs;
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
  validateBackend(config.backend, config.allowedBackendHosts, config.allowManagedServerGenerations);
  if (config.requestTimeoutMs !== undefined && config.requestTimeoutMs <= 0) {
    throw new Error('managed gateway request timeout must be positive');
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
  request: IncomingMessage,
  response: ServerResponse,
  backend: ManagedGatewayBackend,
  port: number,
  timeoutMs: number,
  upstreamRequests: Set<Destroyable>,
  upstreamSockets: Set<Socket>,
  backendClientIdentitySecret: Buffer | undefined,
): void {
  const headers = { ...request.headers };
  for (const header of HOP_BY_HOP) delete headers[header];
  delete headers[MANAGED_CLIENT_IDENTITY_HEADER];
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
      const responseHeaders = { ...upstreamResponse.headers };
      for (const header of HOP_BY_HOP) delete responseHeaders[header];
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );
  upstreamRequests.add(upstream);
  upstream.once('close', () => upstreamRequests.delete(upstream));
  upstream.once('socket', (socket) => trackUpstreamSocket(socket, upstreamSockets));
  upstream.once('timeout', () => upstream.destroy(new Error('managed gateway upstream timeout')));
  upstream.once('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
    response.end('{"error":"upstream unavailable"}');
  });
  request.once('aborted', () => upstream.destroy());
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

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
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
  const publicSockets = new Set<Socket>();
  const internalSockets = new Set<Socket>();
  const upgradedSockets = new Set<Duplex>();
  const upstreamRequests = new Set<Destroyable>();
  const upstreamSockets = new Set<Socket>();
  const activeHttpSockets = new Map<Socket, number>();
  let activeRequests = 0;
  let maintenance = false;
  let draining = false;
  let backend = readPersistedBackend(config);
  const unavailable = (response: ServerResponse): void => {
    response.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
    response.end('{"error":"server maintenance"}');
  };
  const route = (
    request: IncomingMessage,
    response: ServerResponse,
    port: (value: ManagedGatewayBackend) => number,
    requestTimeoutMs: number = timeoutMs,
  ): void => {
    if (maintenance) return unavailable(response);
    activeRequests += 1;
    activeHttpSockets.set(request.socket, (activeHttpSockets.get(request.socket) ?? 0) + 1);
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      activeRequests -= 1;
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
    );
  };
  const publicHandler = (request: IncomingMessage, response: ServerResponse): void => {
    if (!publicPathAllowed(request.url)) {
      response.writeHead(404).end();
      return;
    }
    route(request, response, (value) => value.publicPort);
  };
  const publicServer =
    config.tls === undefined
      ? createServer(publicHandler)
      : createHttpsServer({ key: config.tls.key, cert: config.tls.cert }, publicHandler);
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
  publicServer.on('upgrade', (request, socket, head) => {
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
        const forced = forcedSockets.size;
        const sockets = new Set<CloseableDestroyable>([...forcedSockets, ...upstreamSockets]);
        const closed = [...sockets].map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once('close', resolve);
            }),
        );
        for (const request of upstreamRequests) request.destroy();
        for (const socket of forcedSockets) socket.destroy();
        for (const socket of upstreamSockets) closeManagedGatewayUpstreamSocket(socket);
        await Promise.all(closed);
        return { forced };
      } finally {
        draining = false;
      }
    },
    close: () =>
      (closing ??= Promise.all([
        closeServer(publicServer, publicSockets),
        closeServer(internalServer, internalSockets),
      ]).then(() => undefined)),
  };
}
