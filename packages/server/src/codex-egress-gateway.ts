import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer, type ServerOptions } from 'node:https';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';

import { type CodexGatewayCredential } from './codex-credential-authority.js';
import { CodexCredentialUnavailableError } from './codex-sign-in-error.js';
import {
  CODEX_EGRESS_ORIGIN,
  CodexEgressPolicyError,
  injectCodexEgressCredential,
  validateCodexEgress,
} from './codex-egress-policy.js';
import {
  closeServerBounded,
  DEFAULT_AGENT_GATEWAY_SHUTDOWN_GRACE_MS,
} from './claude-egress-gateway.js';
import { EgressStreamIdleError, forwardBody, isArmableStreamIdleTimeout } from './egress-stream.js';

const CONSUMED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const FORBIDDEN_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface CodexEgressUpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}

export interface CodexEgressForwardRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: IncomingMessage;
  signal: AbortSignal;
  redirect: 'manual';
}

export type CodexEgressForward = (
  request: CodexEgressForwardRequest,
) => Promise<CodexEgressUpstreamResponse>;

export type CodexEgressOutcome =
  'rejected' | 'cancelled' | 'aborted' | 'consumer-closed' | 'completed';

/** Data-minimised request-end telemetry. No raw request or response content is exposed. */
export interface CodexEgressRequestEnd {
  outcome: CodexEgressOutcome;
  reason: string;
  status: number;
  method: string;
  /** Normalized path only. Query names and values are deliberately omitted. */
  path: string;
  bytesForwarded: number;
  durationMs: number;
  /** Present only after the transport peer authenticated. */
  projectId?: string;
}

export type CodexEgressRequestObserver = (event: CodexEgressRequestEnd) => void;

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
const LOGGABLE_PATHS = new Set(['/codex/models', '/codex/responses']);
const UNLOGGABLE = '<other>';

export interface CodexEgressGatewayHandlerOptions {
  listenerAuthority: string;
  authenticatePeer: (socket: Socket) => string | undefined;
  credential: () => Promise<CodexGatewayCredential>;
  refreshAfterUnauthorized?: (previousAccessToken: string) => Promise<unknown>;
  forward?: CodexEgressForward;
  /** Called exactly once for each request. Observer failures never affect egress. */
  onRequestEnd?: CodexEgressRequestObserver;
  /** Overrides the default upstream-silence deadline; 0 disables the supervision. */
  streamIdleTimeoutMs?: number;
}

export interface CodexEgressGatewayOptions extends CodexEgressGatewayHandlerOptions {
  tls: ServerOptions;
  port: number;
  host?: string;
  shutdownGraceMs?: number;
}

export interface CodexEgressGateway {
  readonly port: number;
  reloadTls(tls: ServerOptions): void;
  close(): Promise<void>;
}

export function createCodexEgressGatewayHandler(
  options: CodexEgressGatewayHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  if (options.listenerAuthority.length === 0) {
    throw new Error('Codex egress gateway requires a listener authority');
  }
  // Refuse a malformed deadline at startup rather than per request: 0 is the
  // explicit "no supervision" setting, but a NaN — the shape a misparsed
  // configuration value takes — would silently mean something else entirely.
  if (
    options.streamIdleTimeoutMs !== undefined &&
    options.streamIdleTimeoutMs !== 0 &&
    !isArmableStreamIdleTimeout(options.streamIdleTimeoutMs)
  ) {
    throw new Error('Codex egress stream idle timeout must be zero or a supported positive delay');
  }
  const forward = options.forward ?? forwardCodexEgress;
  return (request, response): void => {
    void handleRequest(request, response, options, forward);
  };
}

export async function startCodexEgressGateway(
  options: CodexEgressGatewayOptions,
): Promise<CodexEgressGateway> {
  requireAuthenticatedClientTls(options.tls);
  const server = createServer(options.tls, createCodexEgressGatewayHandler(options));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
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

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CodexEgressGatewayHandlerOptions,
  forward: CodexEgressForward,
): Promise<void> {
  const abort = new AbortController();
  const startedAt = Date.now();
  let observedProjectId: string | undefined;
  let sentStatus = 0;
  let bytesForwarded = 0;
  let reported = false;
  const report = (outcome: CodexEgressOutcome, reason: string): void => {
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
    if (!authenticatedProjectId) {
      throw new CodexEgressPolicyError('Codex egress peer is not authenticated');
    }
    observedProjectId = authenticatedProjectId;
    if (request.headers.host !== options.listenerAuthority) {
      throw new CodexEgressPolicyError('Codex egress listener authority does not match');
    }
    request.once('aborted', () => abort.abort());
    response.once('close', () => {
      if (!response.writableFinished) {
        abort.abort();
        if (sentStatus === 0) {
          report('cancelled', 'sandbox-closed');
        } else if (sentStatus === 200 && bytesForwarded > 0) {
          // A Responses consumer can close after receiving its logical result but
          // before Node observes the HTTP response as finished. Without parsing
          // SSE content, this is neither provably complete nor a transport error.
          report('consumer-closed', 'downstream-closed');
        } else {
          report('aborted', 'sandbox-closed');
        }
      }
    });
    const method = request.method ?? 'GET';
    const validated = validateCodexEgress({
      method,
      url: new URL(request.url ?? '/', CODEX_EGRESS_ORIGIN),
      headers: requestHeaders(request),
    });
    // Resolve the real credential only after transport identity and all
    // sandbox-controlled request fields passed policy.
    const credential = await options.credential();
    const authorized = injectCodexEgressCredential(validated, credential);
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
      throw new CodexEgressPolicyError('Codex egress upstream redirect was rejected');
    }
    // A POST body cannot be replayed safely. Rotate centrally for the next
    // request, but preserve this upstream response exactly as Codex received it.
    if (upstream.status === 401 && options.refreshAfterUnauthorized !== undefined) {
      void options.refreshAfterUnauthorized(credential.accessToken).catch(() => undefined);
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
    const unavailable = error instanceof CodexCredentialUnavailableError;
    const denied = error instanceof CodexEgressPolicyError;
    const status = unavailable ? 503 : denied ? 403 : 502;
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      ...(unavailable ? { 'retry-after': '2' } : {}),
    });
    sentStatus = status;
    response.end(
      unavailable
        ? 'Codex egress denied: credential unavailable'
        : denied
          ? `Codex egress denied: ${error.message}`
          : 'Codex egress denied: upstream unavailable',
    );
    report(
      'rejected',
      unavailable ? 'credential-unavailable' : denied ? 'policy-rejected' : errorLabel(error),
    );
  }
}

function reportRequestEnd(
  observe: CodexEgressRequestObserver | undefined,
  input: {
    outcome: CodexEgressOutcome;
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
      reason: input.reason,
      status: input.status,
      method: loggableMethod(input.method),
      path: loggablePath(input.target),
      bytesForwarded: input.bytesForwarded,
      durationMs: input.durationMs,
      ...(input.projectId === undefined ? {} : { projectId: loggableProjectId(input.projectId) }),
    });
  } catch {
    // Telemetry is best-effort and must not alter the credential boundary.
  }
}

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

function loggableMethod(method: string | undefined): string {
  return method !== undefined && LOGGABLE_METHODS.has(method) ? method : UNLOGGABLE;
}

function loggableProjectId(projectId: string): string {
  return /^[A-Za-z0-9_.-]{1,128}$/u.test(projectId) ? projectId : UNLOGGABLE;
}

function loggablePath(target: string | undefined): string {
  if (target === undefined) return UNLOGGABLE;
  const path = target.split(/[?#]/u, 1)[0] ?? '';
  return LOGGABLE_PATHS.has(path) ? path : UNLOGGABLE;
}

function requestHeaders(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    if (CONSUMED_REQUEST_HEADERS.has(name)) continue;
    if (values === undefined || values.length !== 1 || values[0] === undefined) {
      throw new CodexEgressPolicyError('Codex egress duplicate header is not allowed');
    }
    result[name] = values[0];
  }
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !FORBIDDEN_RESPONSE_HEADERS.has(name)) result[name] = value;
  }
  return result;
}

function forwardCodexEgress(
  request: CodexEgressForwardRequest,
): Promise<CodexEgressUpstreamResponse> {
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

function requireAuthenticatedClientTls(tls: ServerOptions): void {
  if (tls.requestCert !== true || tls.rejectUnauthorized !== true) {
    throw new Error('Codex egress gateway requires authenticated client TLS');
  }
}
