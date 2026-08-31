import { request as httpsRequest } from 'node:https';
import { createServer, type Server as HttpsServer, type ServerOptions } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';

import {
  CLAUDE_EGRESS_ORIGIN,
  ClaudeEgressCredentialUnavailableError,
  ClaudeEgressPolicyError,
  injectClaudeEgressCredential,
  validateClaudeEgress,
} from './claude-egress-policy.js';
import { EgressStreamIdleError, forwardBody, isArmableStreamIdleTimeout } from './egress-stream.js';

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'location',
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
]);
const CONSUMED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'te',
  'trailer',
  'transfer-encoding',
]);

export interface ClaudeEgressUpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}

export interface ClaudeEgressForwardRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: IncomingMessage;
  signal: AbortSignal;
  redirect: 'manual';
}

export type ClaudeEgressForward = (
  request: ClaudeEgressForwardRequest,
) => Promise<ClaudeEgressUpstreamResponse>;

/**
 * How a proxied request ended.
 *
 * - `rejected` — refused before an upstream response was forwarded (policy, no
 *   credential, upstream unreachable). The sandbox got a local 4xx/5xx response.
 * - `cancelled` — the sandbox disconnected before a response started.
 * - `aborted`  — the response had already started and then broke. This is what
 *   the agent CLI surfaces as "Connection closed mid-response".
 * - `completed` — the upstream response was forwarded in full.
 */
export type ClaudeEgressOutcome = 'rejected' | 'cancelled' | 'aborted' | 'completed';

/**
 * What the gateway may record about one proxied request.
 *
 * Data-minimised by construction: this is the ONLY shape an observer ever
 * receives, and it deliberately carries no request content — no headers, no
 * body, no query VALUES, no client address, no certificate detail. Prompts and
 * personal data live in the body and headers, which never leave this module.
 * Every string is charset-filtered and length-capped before it is handed over,
 * so a hostile sandbox can neither inject log syntax nor use the log as storage.
 */
export interface ClaudeEgressRequestEnd {
  outcome: ClaudeEgressOutcome;
  /**
   * Why it ended, always as a fixed CLASSIFIED label (`policy-rejected`,
   * `Error/ECONNRESET`, `sandbox-closed`, `ok`) rather than a raw message,
   * because provider and network errors can quote upstream response detail.
   */
  reason: string;
  /** Status the sandbox saw. For `aborted` the status already written to it. */
  status: number;
  /** Request method, uppercase, or `<other>` when it is not a known verb. */
  method: string;
  /** Path without query or fragment, or `<other>` when it is not a plain path. */
  path: string;
  /** Allowlisted query names; all others collapse to `<other>`. Sorted, deduped. */
  queryParams: readonly string[];
  /** Response bytes handed to the sandbox before the request ended. */
  bytesForwarded: number;
  /** Time from first byte of the request to this outcome. Separates an instant
   *  reset from a long stall — the question every mid-stream report raises. */
  durationMs: number;
  /** Pseudonymous project id; absent when the peer did not authenticate. */
  projectId?: string;
}

/** Observe finished requests. Must not retain the record beyond emitting it. */
export type ClaudeEgressRequestObserver = (event: ClaudeEgressRequestEnd) => void;

const LOGGABLE_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);
const LOGGABLE_ERROR_NAMES = new Set(['Error', 'AbortError', 'TypeError']);
const LOGGABLE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);
/** Conservative: ordinary API path characters only, no percent-escapes. */
const LOGGABLE_PATH = /^\/[A-Za-z0-9/_.-]{0,127}$/u;
const LOGGABLE_PARAM_NAME = /^[A-Za-z0-9_.-]{1,32}$/u;
const MAX_LOGGED_PARAMS = 8;
const MAX_LOGGED_REASON = 200;
const UNLOGGABLE = '<other>';

export interface ClaudeEgressGatewayHandlerOptions {
  /**
   * Project this listener is pinned to (single-project / isolated-listener mode):
   * the authenticated peer MUST match it. Omit for MULTI-TENANT mode — one shared
   * listener where the mTLS-authenticated peer identity itself is the credential
   * scope (the fingerprint→project map is server-issued, so a peer can only ever
   * present its own project). In both modes the credential scope equals the
   * authenticated project; the pin is an extra isolation guard, never the source
   * of identity.
   */
  projectId?: string | undefined;
  /** Exact internal authority Claude is configured to call, including port. */
  listenerAuthority: string;
  /**
   * Resolve identity exclusively from trusted transport state (for example an
   * mTLS peer certificate or an isolated per-project listener). Implementations
   * must never inspect HTTP headers, URL, or body.
   */
  authenticatePeer: (socket: Socket) => string | undefined;
  accessToken: (projectId: string) => Promise<string>;
  forward?: ClaudeEgressForward;
  /**
   * Called exactly once per proxied request, whatever its outcome. Optional:
   * omitting it keeps the gateway silent, so no deployment starts recording by
   * accident. A throwing observer must never affect the response the sandbox
   * receives. The authenticated readiness probe is not reported.
   */
  onRequestEnd?: ClaudeEgressRequestObserver;
  /** Overrides the default upstream-silence deadline; 0 disables the supervision. */
  streamIdleTimeoutMs?: number;
}

export interface ClaudeEgressGatewayOptions extends ClaudeEgressGatewayHandlerOptions {
  tls: ServerOptions;
  port: number;
  host?: string;
  shutdownGraceMs?: number;
}

export interface ClaudeEgressGateway {
  readonly port: number;
  /** Replace the listener certificate and trust bundle for new TLS handshakes
   * without interrupting established provider streams. */
  reloadTls(tls: ServerOptions): void;
  close(): Promise<void>;
}

/** Long enough for an ordinary agent turn to finish during a planned gateway
 * replacement. Forced closure remains bounded so supervision cannot hang forever. */
export const DEFAULT_AGENT_GATEWAY_SHUTDOWN_GRACE_MS = 10 * 60 * 1_000;

/**
 * Build the streaming request handler separately from its HTTPS listener so the
 * credential boundary can be integration-tested without real Anthropic calls.
 */
export function createClaudeEgressGatewayHandler(
  options: ClaudeEgressGatewayHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  if (options.listenerAuthority.length === 0) {
    throw new Error('Claude egress gateway requires a listener authority');
  }
  if (options.projectId !== undefined && options.projectId.length === 0) {
    throw new Error('Claude egress gateway project must be non-empty when pinned');
  }
  // Refuse a malformed deadline at startup rather than per request: 0 is the
  // explicit "no supervision" setting, but a NaN — the shape a misparsed
  // configuration value takes — would silently mean something else entirely.
  if (
    options.streamIdleTimeoutMs !== undefined &&
    options.streamIdleTimeoutMs !== 0 &&
    !isArmableStreamIdleTimeout(options.streamIdleTimeoutMs)
  ) {
    throw new Error('Claude egress stream idle timeout must be zero or a supported positive delay');
  }
  const forward = options.forward ?? forwardClaudeEgress;

  return (request, response): void => {
    void handleRequest(request, response, options, forward);
  };
}

/** @internal Use startClaudeEgressMtlsGateway outside this module. */
export async function startClaudeEgressGateway(
  options: ClaudeEgressGatewayOptions,
): Promise<ClaudeEgressGateway> {
  requireAuthenticatedClientTls(options.tls);
  const server = createServer(options.tls, createClaudeEgressGatewayHandler(options));
  await listen(server, options.port, options.host ?? '127.0.0.1');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    port,
    reloadTls(tls): void {
      requireAuthenticatedClientTls(tls);
      server.setSecureContext(tls);
    },
    close: () =>
      closeServerBounded(
        server,
        options.shutdownGraceMs ?? DEFAULT_AGENT_GATEWAY_SHUTDOWN_GRACE_MS,
      ),
  };
}

function requireAuthenticatedClientTls(tls: ServerOptions): void {
  if (tls.requestCert !== true || tls.rejectUnauthorized !== true) {
    throw new Error('Claude egress gateway requires authenticated client TLS');
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ClaudeEgressGatewayHandlerOptions,
  forward: ClaudeEgressForward,
): Promise<void> {
  const abort = new AbortController();
  const startedAt = Date.now();
  // Only set once the peer is authenticated, so a report can never attribute a
  // request to a project that did not make it.
  let observedProjectId: string | undefined;
  let sentStatus = 0;
  let bytesForwarded = 0;
  let reported = false;
  /** Report the FIRST terminal outcome only: a broken stream produces an error
   *  and a close, and the error is the one that explains anything. */
  const report = (outcome: ClaudeEgressOutcome, reason: string): void => {
    if (reported) return;
    reported = true;
    reportRequestEnd(options.onRequestEnd, {
      outcome,
      reason,
      status: sentStatus,
      method: request.method,
      target: request.url,
      bytesForwarded,
      durationMs: Date.now() - startedAt,
      projectId: observedProjectId,
    });
  };
  try {
    const authenticatedProjectId = options.authenticatePeer(request.socket);
    // Reject a falsy identity (undefined OR empty string) at the source — this is
    // the gate for the crown-jewel credential, so it must be self-sufficient and
    // not lean on the registry's non-empty invariant or the downstream policy.
    if (!authenticatedProjectId) {
      throw new ClaudeEgressPolicyError('Claude egress peer is not authenticated');
    }
    // Single-project (pinned) mode: the peer must be exactly this listener's
    // project. Multi-tenant mode (no pin): the authenticated peer IS the scope.
    if (options.projectId !== undefined && authenticatedProjectId !== options.projectId) {
      throw new ClaudeEgressPolicyError('Claude egress peer identity does not match project');
    }
    const scopedProjectId = options.projectId ?? authenticatedProjectId;
    observedProjectId = scopedProjectId;
    if (request.headers.host !== options.listenerAuthority) {
      throw new ClaudeEgressPolicyError('Claude egress listener authority does not match');
    }
    const method = request.method ?? 'GET';
    // Authenticated end-to-end readiness probe: unlike the connector's local
    // readiness path, this request has crossed mTLS and peer authorization. It
    // deliberately stops before resolving the OAuth token or contacting Anthropic.
    if (method === 'GET' && request.url === '/__verity/gateway-ready') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: true, authenticated: true }));
      return;
    }
    request.once('aborted', () => abort.abort());
    response.once('close', () => {
      if (!response.writableFinished) {
        abort.abort();
        // A close before headers is a cancelled request, not a broken response.
        // Once a status was written, distinguish the sandbox hanging up from an
        // upstream stream failure.
        report(sentStatus === 0 ? 'cancelled' : 'aborted', 'sandbox-closed');
      }
    });
    const target = new URL(request.url ?? '/', CLAUDE_EGRESS_ORIGIN);
    const headers = requestHeaders(request);
    const validated = validateClaudeEgress(
      {
        url: target,
        method,
        headers,
        transportAuthority: 'api.anthropic.com:443',
      },
      {
        authenticatedProjectId,
        credentialProjectId: scopedProjectId,
      },
    );
    // Resolve/materialize the secret only after every caller-controlled field and
    // the out-of-band peer identity have passed the fail-closed policy.
    const token = await options.accessToken(scopedProjectId);
    const authorized = injectClaudeEgressCredential(validated, token);
    const upstream = await forward({
      method,
      url: authorized.url,
      headers: authorized.headers,
      body: request,
      signal: abort.signal,
      redirect: authorized.redirect,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      upstream.body.destroy();
      throw new ClaudeEgressPolicyError('Claude egress upstream redirect was rejected');
    }
    sentStatus = upstream.status;
    response.writeHead(upstream.status, responseHeaders(upstream.headers));
    response.once('finish', () => report('completed', 'ok'));
    const suppressesBody = method === 'HEAD' || upstream.status === 204 || upstream.status === 304;
    await forwardBody(
      upstream.body,
      response,
      (bytes) => {
        if (!suppressesBody) bytesForwarded += bytes;
      },
      options.streamIdleTimeoutMs,
    );
  } catch (error) {
    if (response.headersSent) {
      report('aborted', errorLabel(error));
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const unavailable = error instanceof ClaudeEgressCredentialUnavailableError;
    const denied = error instanceof ClaudeEgressPolicyError;
    const status = unavailable ? 503 : denied ? 403 : 502;
    // Provider/network errors may contain upstream response details or secrets.
    // Only policy failures are safe to reflect to the untrusted sandbox.
    const message = unavailable
      ? 'Claude egress credential unavailable'
      : denied
        ? error.message
        : 'upstream unavailable';
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      ...(unavailable ? { 'retry-after': '2' } : {}),
    });
    sentStatus = status;
    response.end(`Claude egress denied: ${message}`);
    // After the response: observing an outcome must never delay or alter it.
    // Policy messages may name attacker-chosen headers, so logs receive only a
    // fixed classification. Provider and network errors are classified too.
    report(
      'rejected',
      unavailable ? 'credential-unavailable' : denied ? 'policy-rejected' : errorLabel(error),
    );
  }
}

/** Build the data-minimised record and hand it over, absorbing observer faults. */
function reportRequestEnd(
  observe: ClaudeEgressRequestObserver | undefined,
  input: {
    outcome: ClaudeEgressOutcome;
    reason: string;
    status: number;
    method: string | undefined;
    target: string | undefined;
    bytesForwarded: number;
    durationMs: number;
    projectId: string | undefined;
  },
): void {
  if (observe === undefined) return;
  try {
    observe({
      outcome: input.outcome,
      reason: loggableReason(input.reason),
      status: input.status,
      method: loggableMethod(input.method),
      path: loggablePath(input.target),
      queryParams: loggableQueryParams(input.target),
      bytesForwarded: input.bytesForwarded,
      durationMs: input.durationMs,
      ...(input.projectId === undefined ? {} : { projectId: loggableProjectId(input.projectId) }),
    });
  } catch {
    // A broken observer is a logging defect, never a reason to change the
    // security-relevant response the sandbox has already been given.
  }
}

/**
 * Classify an error instead of quoting it: name plus `code` is what actually
 * separates a peer reset from a TLS fault or a premature close, and unlike the
 * message it cannot carry upstream response text.
 */
function errorLabel(error: unknown): string {
  // Distinct from every network label: this stream was ended BY the gateway
  // because upstream stopped, which is the one abort cause no packet capture on
  // either side can show.
  if (error instanceof EgressStreamIdleError) return 'upstream-idle';
  if (!(error instanceof Error) || !LOGGABLE_ERROR_NAMES.has(error.name)) return UNLOGGABLE;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === undefined) return error.name;
  return LOGGABLE_ERROR_CODES.has(code) ? `${error.name}/${code}` : UNLOGGABLE;
}

function loggableReason(reason: string): string {
  // Most reasons are constant, but a few embed a caller-chosen header name.
  const safe = reason.replace(/[^A-Za-z0-9 :,._/-]/gu, '');
  return safe.length > MAX_LOGGED_REASON ? `${safe.slice(0, MAX_LOGGED_REASON)}…` : safe;
}

function loggableMethod(method: string | undefined): string {
  return method !== undefined && LOGGABLE_METHODS.has(method) ? method : UNLOGGABLE;
}

function loggableProjectId(projectId: string): string {
  return /^[A-Za-z0-9_.-]{1,128}$/u.test(projectId) ? projectId : UNLOGGABLE;
}

/** The path only, and only when it looks like an ordinary API route. Anything
 *  unusual collapses to a placeholder rather than echoing sandbox-chosen text. */
function loggablePath(target: string | undefined): string {
  if (target === undefined) return UNLOGGABLE;
  const path = target.split(/[?#]/u, 1)[0] ?? '';
  return LOGGABLE_PATH.test(path) ? path : UNLOGGABLE;
}

/** Allowlisted parameter names only. Values are never recorded, and arbitrary
 * names collapse so the log cannot become a sandbox-controlled side channel. */
function loggableQueryParams(target: string | undefined): readonly string[] {
  if (target === undefined) return [];
  const query = target.split('#', 1)[0]?.split('?').slice(1).join('?') ?? '';
  if (query === '') return [];
  const names = new Set<string>();
  for (const name of new URLSearchParams(query).keys()) {
    names.add(LOGGABLE_PARAM_NAME.test(name) && name === 'beta' ? name : UNLOGGABLE);
    if (names.size >= MAX_LOGGED_PARAMS) break;
  }
  return [...names].sort();
}

function requestHeaders(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    // Node's HTTP parser has already consumed framing and rejects conflicting
    // Content-Length/Transfer-Encoding. Never replay those hop-by-hop fields;
    // the outbound client derives fresh framing from the streamed body.
    if (CONSUMED_REQUEST_HEADERS.has(name)) continue;
    if (values === undefined || values.length !== 1) {
      throw new ClaudeEgressPolicyError('Claude egress duplicate header is not allowed');
    }
    const value = values[0];
    if (value === undefined) {
      throw new ClaudeEgressPolicyError('Claude egress header is invalid');
    }
    result[name] = value;
  }
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || FORBIDDEN_RESPONSE_HEADERS.has(name)) continue;
    result[name] = value;
  }
  return result;
}

function forwardClaudeEgress(
  request: ClaudeEgressForwardRequest,
): Promise<ClaudeEgressUpstreamResponse> {
  return new Promise((resolve, reject) => {
    const upstream = httpsRequest(
      request.url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        signal: request.signal,
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 502,
          headers: response.headers,
          body: response,
        }),
    );
    upstream.once('error', reject);
    request.body.pipe(upstream);
  });
}

function listen(server: HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

interface CloseableServer {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections(): void;
}

export function closeServerBounded(server: CloseableServer, graceMs: number): Promise<void> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    return Promise.reject(new Error('Claude egress shutdown grace must be non-negative'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, graceMs);
    timer.unref();
    server.close((error) => finish(error));
  });
}
