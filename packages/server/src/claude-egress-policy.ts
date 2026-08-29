/**
 * Credential-injection policy for Claude traffic (ADR 0002 D4 / ADR 0006 D10).
 *
 * The sandbox sends a deliberately useless bearer value. Only the trusted
 * egress proxy calls this function and substitutes the current access token in
 * the outbound request. Keeping the rewrite as a pure, fail-closed policy makes
 * the security boundary testable independently from CONNECT/TLS plumbing.
 */

export const CLAUDE_EGRESS_ORIGIN = 'https://api.anthropic.com';
export const CLAUDE_EGRESS_PLACEHOLDER = 'verity-claude-egress-placeholder-v1';

export class ClaudeEgressPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeEgressPolicyError';
  }
}

export class ClaudeEgressCredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeEgressCredentialUnavailableError';
  }
}

export interface ClaudeEgressRequest {
  url: string | URL;
  method: string;
  headers: Headers | Record<string, string>;
  /** Full CONNECT authority (`host:port`) observed by the proxy, never an HTTP header. */
  transportAuthority: string;
}

export interface ClaudeEgressIdentity {
  /** Project assigned to this listener or authenticated transport peer. */
  authenticatedProjectId: string;
  /** Project whose Server-managed credential would be used. */
  credentialProjectId: string;
}

export interface AuthorizedClaudeEgressRequest {
  url: URL;
  headers: Headers;
  /** Outbound clients MUST NOT automatically replay the injected credential. */
  redirect: 'manual';
}

export interface ValidatedClaudeEgressRequest {
  url: URL;
  headers: Headers;
  redirect: 'manual';
}

const FORBIDDEN_CLIENT_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'anthropic-user-profile-id',
]);

const INFERENCE_ENDPOINTS = new Map([
  ['/v1/messages', new Set(['POST'])],
  ['/v1/messages/count_tokens', new Set(['POST'])],
]);

/**
 * Exact query strings the Claude CLI appends to its inference calls.
 * Byte-exact matching prevents duplicate or encoded parameter names from
 * introducing parameter-pollution ambiguity upstream.
 */
const INFERENCE_QUERIES = new Set(['', '?beta=true']);

/**
 * Validate one decrypted proxy request and inject the real Claude credential.
 * No caller-controlled origin, alternate credential header, or malformed token
 * is accepted. The returned headers are a copy; the input is never mutated.
 */
export function authorizeClaudeEgress(
  request: ClaudeEgressRequest,
  identity: ClaudeEgressIdentity,
  accessToken: string,
): AuthorizedClaudeEgressRequest {
  return injectClaudeEgressCredential(validateClaudeEgress(request, identity), accessToken);
}

/** Validate every untrusted request field before a credential is resolved. */
export function validateClaudeEgress(
  request: ClaudeEgressRequest,
  identity: ClaudeEgressIdentity,
): ValidatedClaudeEgressRequest {
  const url = parseUrl(request.url);
  if (url.origin !== CLAUDE_EGRESS_ORIGIN || url.username !== '' || url.password !== '') {
    throw new ClaudeEgressPolicyError('Claude egress origin is not allowed');
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) {
    throw new ClaudeEgressPolicyError('Claude egress requires HTTPS on the default port');
  }
  if (
    url.hash !== '' ||
    !INFERENCE_ENDPOINTS.get(url.pathname)?.has(request.method) ||
    !INFERENCE_QUERIES.has(url.search)
  ) {
    throw new ClaudeEgressPolicyError('Claude egress inference endpoint is not allowed');
  }
  const expectedTransportAuthority = `${url.hostname}:443`;
  if (request.transportAuthority.toLowerCase() !== expectedTransportAuthority) {
    throw new ClaudeEgressPolicyError('Claude egress transport authority does not match URL');
  }
  if (
    identity.authenticatedProjectId.length === 0 ||
    identity.authenticatedProjectId !== identity.credentialProjectId
  ) {
    throw new ClaudeEgressPolicyError('Claude egress project identity does not match credential');
  }
  const headers = new Headers(request.headers);
  const expected = `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`;
  if (headers.get('authorization') !== expected) {
    throw new ClaudeEgressPolicyError('Claude egress placeholder is missing');
  }
  if (headers.has('x-api-key')) {
    throw new ClaudeEgressPolicyError('Claude egress does not accept client API keys');
  }
  for (const name of headers.keys()) {
    if (FORBIDDEN_CLIENT_HEADERS.has(name) || name.startsWith('x-forwarded-')) {
      throw new ClaudeEgressPolicyError(`Claude egress header is not allowed: ${name}`);
    }
  }
  return { url, headers, redirect: 'manual' };
}

/** Inject a Server-only credential into an already validated request copy. */
export function injectClaudeEgressCredential(
  request: ValidatedClaudeEgressRequest,
  accessToken: string,
): AuthorizedClaudeEgressRequest {
  if (accessToken.length === 0 || /[\r\n]/u.test(accessToken)) {
    throw new ClaudeEgressPolicyError('Claude access token is invalid');
  }
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  return { url: request.url, headers, redirect: request.redirect };
}

function parseUrl(value: string | URL): URL {
  try {
    return new URL(value);
  } catch {
    throw new ClaudeEgressPolicyError('Claude egress URL is invalid');
  }
}
