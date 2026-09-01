#!/usr/bin/env node

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

export const CONNECTOR_PROTOCOL_VERSION = 1;
export const CONNECTOR_HOST = '127.0.0.1';
const READY_PATH = '/__verity/ready';
const CONSUMED_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
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
const MAX_LOGGED_REASON = 200;

function validPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('Claude connector requires a valid port');
  }
  return port;
}

export function validateEgressConnectorOptions(options) {
  const port = validPort(options.port);
  const egressUrl = new URL(options.egressUrl);
  if (
    egressUrl.protocol !== 'https:' ||
    egressUrl.username !== '' ||
    egressUrl.password !== '' ||
    egressUrl.search !== '' ||
    egressUrl.hash !== '' ||
    (egressUrl.pathname !== '/' && egressUrl.pathname !== '')
  ) {
    throw new Error('Claude connector requires an HTTPS egress origin');
  }
  let authorityUrl;
  try {
    authorityUrl = new URL(`https://${options.egressAuthority}`);
  } catch {
    throw new Error('Claude connector requires a valid egress authority');
  }
  if (
    authorityUrl.host !== options.egressAuthority ||
    authorityUrl.username !== '' ||
    authorityUrl.password !== '' ||
    authorityUrl.pathname !== '/' ||
    authorityUrl.search !== '' ||
    authorityUrl.hash !== ''
  ) {
    throw new Error('Claude connector requires a valid egress authority');
  }
  if (!options.ca || !options.cert || !options.key) {
    throw new Error('Claude connector requires mTLS material');
  }
  let codexEgressUrl;
  if (options.codexEgressUrl !== undefined || options.codexEgressAuthority !== undefined) {
    if (!options.codexEgressUrl || !options.codexEgressAuthority) {
      throw new Error('Codex connector configuration is incomplete');
    }
    codexEgressUrl = new URL(options.codexEgressUrl);
    if (
      codexEgressUrl.protocol !== 'https:' ||
      codexEgressUrl.username !== '' ||
      codexEgressUrl.password !== '' ||
      codexEgressUrl.search !== '' ||
      codexEgressUrl.hash !== '' ||
      (codexEgressUrl.pathname !== '/' && codexEgressUrl.pathname !== '')
    )
      throw new Error('Codex connector requires an HTTPS egress origin');
    let codexAuthorityUrl;
    try {
      codexAuthorityUrl = new URL(`https://${options.codexEgressAuthority}`);
    } catch {
      throw new Error('Codex connector requires a valid egress authority');
    }
    if (
      codexAuthorityUrl.host !== options.codexEgressAuthority ||
      codexAuthorityUrl.username !== '' ||
      codexAuthorityUrl.password !== '' ||
      codexAuthorityUrl.pathname !== '/' ||
      codexAuthorityUrl.search !== '' ||
      codexAuthorityUrl.hash !== ''
    )
      throw new Error('Codex connector requires a valid egress authority');
  }
  return { port, egressUrl, codexEgressUrl };
}

export function createEgressConnectorHandler(options) {
  const { egressUrl, codexEgressUrl } = validateEgressConnectorOptions(options);
  const forward = options.forward ?? forwardRequest;
  return (request, response) => {
    void handle(request, response, options, egressUrl, codexEgressUrl, forward);
  };
}

export async function runEgressConnector(options) {
  const { port } = validateEgressConnectorOptions(options);
  const server = createServer();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, CONNECTOR_HOST, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  const effectiveOptions =
    port === 0 && options.localAuthority === `${CONNECTOR_HOST}:0`
      ? { ...options, localAuthority: `${CONNECTOR_HOST}:${boundPort}` }
      : options;
  server.on('request', createEgressConnectorHandler(effectiveOptions));
  return {
    host: CONNECTOR_HOST,
    port: boundPort,
    close: () => closeServerBounded(server, options.shutdownGraceMs ?? 5_000),
  };
}

export function closeServerBounded(server, graceMs) {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    return Promise.reject(new Error('Claude connector shutdown grace must be non-negative'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
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

async function handle(request, response, options, egressUrl, codexEgressUrl, forward) {
  const startedAt = Date.now();
  let sentStatus = 0;
  let bytesForwarded = 0;
  let reported = false;
  // Which gateway the request ended up depending on: "Claude connector" named
  // the wrong one for every Codex turn. Anything the connector settles before
  // forwarding — a wrong local authority, its own readiness probe, a target it
  // refuses — depended on neither gateway and reads `unrouted`, whichever leg
  // routing had picked. It is deliberately not "the side at fault": a turn the
  // agent abandons mid-stream still names the gateway it was streaming from,
  // and `outcome` is what says whose doing the ending was.
  let leg = 'unrouted';
  let attempted = false;
  // The body and the record read this, so they cannot name different legs.
  // `codex-unconfigured` is the exception: the connector's verdict ABOUT a
  // gateway rather than a fault of one.
  const reportedLeg = () => (attempted || leg === 'codex-unconfigured' ? leg : 'unrouted');
  // Report the FIRST terminal outcome only: a broken stream produces an error
  // and a close, and the error is the one that explains anything.
  const report = (outcome, reason) => {
    if (reported) return;
    reported = true;
    logRequestEnd({
      outcome,
      reason,
      leg: reportedLeg(),
      status: sentStatus,
      method: request.method,
      target: request.url,
      bytesForwarded,
      durationMs: Date.now() - startedAt,
    });
  };
  const requestPath = request.url ?? '/';
  const codex = requestPath === '/codex' || requestPath.startsWith('/codex/');
  try {
    const hostValues = request.headersDistinct.host;
    if (!hostValues || hostValues.length !== 1 || hostValues[0] !== options.localAuthority) {
      throw new Error('local authority mismatch');
    }
    if (requestPath === READY_PATH && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ protocolVersion: CONNECTOR_PROTOCOL_VERSION, ready: true }));
      return;
    }
    leg = codex ? (codexEgressUrl === undefined ? 'codex-unconfigured' : 'codex') : 'claude';
    if (codex && codexEgressUrl === undefined) throw new Error('Codex egress is unavailable');
    const selectedEgress = codex ? codexEgressUrl : egressUrl;
    const target = new URL(requestPath, selectedEgress);
    if (target.origin !== selectedEgress.origin) throw new Error('egress origin escape');
    const headers = normalizedHeaders(request);
    headers.host = codex ? options.codexEgressAuthority : options.egressAuthority;
    const abort = new globalThis.AbortController();
    request.once('aborted', () => abort.abort());
    response.once('close', () => {
      if (!response.writableFinished) {
        abort.abort();
        // A close before headers is a cancelled request, not a broken response.
        // Once a status was written, distinguish the agent hanging up from the
        // gateway breaking the stream.
        report(sentStatus === 0 ? 'cancelled' : 'aborted', 'agent-closed');
      }
    });
    // From here on a failure before headers is the gateway's: either the
    // forward itself, or the one thing the connector refuses about a reply it
    // did get (a redirect). Everything rejected above this line is the
    // connector's own doing, whichever leg routing had already selected.
    attempted = true;
    const upstream = await forward({
      url: target,
      method: request.method ?? 'GET',
      headers,
      body: request,
      signal: abort.signal,
      tls: {
        ca: options.ca,
        cert: options.cert,
        key: options.key,
        servername: codex
          ? new URL(`https://${options.codexEgressAuthority}`).hostname
          : (options.servername ?? selectedEgress.hostname),
      },
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      abort.abort();
      upstream.body.destroy();
      throw new Error('upstream redirect rejected');
    }
    sentStatus = upstream.status;
    response.writeHead(upstream.status, responseHeaders(upstream.headers));
    response.once('finish', () => report('completed', 'ok'));
    const suppressesBody =
      request.method === 'HEAD' || upstream.status === 204 || upstream.status === 304;
    await forwardBody(upstream.body, response, (bytes) => {
      if (!suppressesBody) bytesForwarded += bytes;
    });
  } catch (error) {
    if (response.headersSent) {
      report('aborted', errorLabel(error));
      response.destroy();
    } else {
      sentStatus = 502;
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(unavailableBody(reportedLeg(), error));
      report('rejected', errorLabel(error));
    }
  }
}

async function forwardBody(body, response, forwarded) {
  for await (const chunk of body) {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    await new Promise((resolve, reject) => {
      response.write(chunk, (error) => (error == null ? resolve() : reject(error)));
    });
    forwarded(bytes);
  }
  response.end();
}

/**
 * One JSON line per finished request, on stderr.
 *
 * This runs INSIDE the sandbox, so it may only state what the sandbox already
 * knows about its own request: never a header, a body, a query value or a
 * credential — the connector never sees the real token anyway. Together with
 * the gateway's record it answers the only question a mid-response break
 * raises: which side closed the stream, and after how many bytes.
 */
function logRequestEnd(input) {
  const path = String(input.target ?? '').split(/[?#]/u, 1)[0] ?? '';
  process.stderr.write(
    `${JSON.stringify({
      event: 'egress-connector',
      outcome: input.outcome,
      reason: loggableReason(input.reason),
      // Which gateway the request ended up depending on — `unrouted` when the
      // connector settled it itself — so the record answers the same question
      // its failure body does. Read it with `outcome`: this names the gateway
      // involved, not the side that ended the request.
      leg: input.leg,
      status: input.status,
      method: LOGGABLE_METHODS.has(input.method) ? input.method : '<other>',
      path: LOGGABLE_PATH.test(path) ? path : '<other>',
      bytesForwarded: input.bytesForwarded,
      durationMs: input.durationMs,
    })}\n`,
  );
}

/** Classify rather than quote: `code` is what separates a peer reset from a TLS
 *  fault, and unlike the message it cannot carry upstream response text. */
function errorLabel(error) {
  if (!(error instanceof Error) || !LOGGABLE_ERROR_NAMES.has(error.name)) return '<other>';
  if (error.code === undefined) return error.name;
  return LOGGABLE_ERROR_CODES.has(error.code) ? `${error.name}/${error.code}` : '<other>';
}

/** Where the syscall code sits depends on how the connection was attempted, and
 *  the message that offers the repair must not hinge on that. `https.request`
 *  puts it on the error itself, but a dual-stack connect rejects with an
 *  `AggregateError` carrying one error per address, and a fetch-shaped forward
 *  wraps it in `cause` — miss those and a refused Codex gateway silently loses
 *  the one line that says what to fix. Depth-bounded: the chain is walked, not
 *  trusted to end. */
function hasErrorCode(error, code, depth = 0) {
  if (!(error instanceof Error) || depth > 4) return false;
  if (error.code === code) return true;
  if (Array.isArray(error.errors)) {
    if (error.errors.some((nested) => hasErrorCode(nested, code, depth + 1))) return true;
  }
  return hasErrorCode(error.cause, code, depth + 1);
}

/** The only thing the agent gets to see when a forward fails before headers, so
 *  it names the leg that broke and, where one cause dominates, the repair.
 *  Codex has two distinct states: no codex egress in this Sandbox's environment
 *  at all, because it was provisioned before the Codex gateway existed, versus a
 *  configured gateway the forward could not reach. Only a refused connection is
 *  told what to repair — nothing is listening, and in a Verity deployment the
 *  gateway opens its Codex listener only once a credential exists. Named as the
 *  likely cause rather than the certain one: the connector forwards to whatever
 *  `codexEgressUrl` points at, and a relay or a stopped sidecar in front of the
 *  gateway refuses the same way. A timeout, a
 *  DNS or a TLS fault gets the bare fact, because sending an operator to the
 *  credential settings for those is the misdiagnosis this whole change is about.
 *  A request the connector rejected itself, before the forward was attempted,
 *  names no gateway at all — blaming one for the connector's own verdict is the
 *  same misdirection in the other direction. Every case stays 502: codex treats
 *  it as terminal, and a 503 would send it round its reconnect loop before the
 *  text is ever read. */
function unavailableBody(leg, error) {
  if (leg === 'codex') {
    return hasErrorCode(error, 'ECONNREFUSED')
      ? 'Codex egress unavailable: the configured Codex egress refused the connection. In a Verity deployment that most often means the agent gateway has no Codex credentials configured yet, because it opens its Codex listener only once they exist.'
      : 'Codex egress unavailable: the Verity agent gateway did not serve the Codex request.';
  }
  if (leg === 'codex-unconfigured') {
    return 'Codex egress is not configured for this Sandbox: it was provisioned without a Codex gateway.';
  }
  if (leg === 'claude') {
    return 'Claude connector upstream unavailable';
  }
  // `unrouted` and anything a later leg introduces. Naming Claude here is how
  // every Codex turn came to blame the Claude gateway in the first place, so an
  // unrecognised leg says nothing about which gateway rather than guessing one.
  return 'Verity sandbox connector rejected the request before any gateway was reached.';
}

function loggableReason(reason) {
  const safe = String(reason).replace(/[^A-Za-z0-9 :,._/-]/gu, '');
  return safe.length > MAX_LOGGED_REASON ? `${safe.slice(0, MAX_LOGGED_REASON)}…` : safe;
}

function normalizedHeaders(request) {
  const headers = {};
  const connectionValues = request.headersDistinct.connection ?? [];
  if (connectionValues.length > 1) throw new Error('ambiguous connection header');
  const nominated = new Set(
    (connectionValues[0] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ''),
  );
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    if (CONSUMED_HEADERS.has(name) || nominated.has(name)) continue;
    if (!values || values.length !== 1) throw new Error('ambiguous request header');
    headers[name] = values[0];
  }
  return headers;
}

function responseHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => value !== undefined && !CONSUMED_HEADERS.has(name),
    ),
  );
}

function forwardRequest(request) {
  return new Promise((resolve, reject) => {
    const upstream = httpsRequest(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        ...request.tls,
        minVersion: 'TLSv1.3',
        rejectUnauthorized: true,
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

async function main() {
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`missing ${name}`);
    return value;
  };
  const [ca, cert, key] = await Promise.all([
    readFile(required('VERITY_CLAUDE_EGRESS_CA'), 'utf8'),
    readFile(required('VERITY_CLAUDE_EGRESS_CERT'), 'utf8'),
    readFile(required('VERITY_CLAUDE_EGRESS_KEY'), 'utf8'),
  ]);
  const connector = await runEgressConnector({
    port: required('VERITY_CLAUDE_CONNECTOR_PORT'),
    localAuthority: required('VERITY_CLAUDE_CONNECTOR_AUTHORITY'),
    egressUrl: required('VERITY_CLAUDE_EGRESS_URL'),
    egressAuthority: required('VERITY_CLAUDE_EGRESS_AUTHORITY'),
    ca,
    cert,
    key,
    servername: process.env.VERITY_CLAUDE_EGRESS_SERVERNAME,
    codexEgressUrl: process.env.VERITY_CODEX_EGRESS_URL,
    codexEgressAuthority: process.env.VERITY_CODEX_EGRESS_AUTHORITY,
  });
  process.stdout.write(`verity-egress-connector ready on ${connector.host}:${connector.port}\n`);
  const close = () => void connector.close().finally(() => process.exit(0));
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`verity-egress-connector: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
