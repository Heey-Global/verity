import type { CodexGatewayCredential } from './codex-credential-authority.js';

export const CODEX_EGRESS_ORIGIN = 'https://chatgpt.com';

const ROUTES = new Map<string, { method: string; upstreamPath: string }>([
  ['/codex/models', { method: 'GET', upstreamPath: '/backend-api/codex/models' }],
  ['/codex/responses', { method: 'POST', upstreamPath: '/backend-api/codex/responses' }],
]);

const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  'chatgpt-account-id',
  'cookie',
  'openai-organization',
  'openai-project',
  'proxy-authorization',
  'x-api-key',
]);

export class CodexEgressPolicyError extends Error {}

export interface ValidatedCodexEgress {
  method: string;
  url: URL;
  headers: Headers;
  redirect: 'manual';
}

/** Validate every sandbox-controlled field before resolving the real OAuth credential. */
export function validateCodexEgress(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
}): ValidatedCodexEgress {
  if (input.url.origin !== CODEX_EGRESS_ORIGIN || input.url.username || input.url.password) {
    throw new CodexEgressPolicyError('Codex egress origin is not allowed');
  }
  if (input.url.search !== '' || input.url.hash !== '') {
    throw new CodexEgressPolicyError('Codex egress query and fragment are not allowed');
  }
  const route = ROUTES.get(input.url.pathname);
  if (route === undefined || input.method !== route.method) {
    throw new CodexEgressPolicyError('Codex egress route is not allowed');
  }
  const headers = new Headers();
  let placeholderSeen = false;
  for (const [rawName, value] of Object.entries(input.headers)) {
    const name = rawName.toLowerCase();
    if (/[\r\n]/u.test(value)) throw new CodexEgressPolicyError('Codex egress header is invalid');
    if (name === 'authorization') {
      if (!/^Bearer [A-Za-z0-9._~-]{1,256}$/u.test(value)) {
        throw new CodexEgressPolicyError('Codex egress placeholder credential is invalid');
      }
      placeholderSeen = true;
      continue;
    }
    if (FORBIDDEN_CREDENTIAL_HEADERS.has(name)) {
      throw new CodexEgressPolicyError('Codex egress credential header is not allowed');
    }
    headers.set(name, value);
  }
  if (!placeholderSeen) {
    throw new CodexEgressPolicyError('Codex egress placeholder credential is missing');
  }
  return {
    method: input.method,
    url: new URL(route.upstreamPath, CODEX_EGRESS_ORIGIN),
    headers,
    redirect: 'manual',
  };
}

export function injectCodexEgressCredential(
  request: ValidatedCodexEgress,
  credential: CodexGatewayCredential,
): ValidatedCodexEgress {
  if (
    credential.accessToken.length === 0 ||
    credential.accountId.length === 0 ||
    /[\r\n]/u.test(credential.accessToken) ||
    /[\r\n]/u.test(credential.accountId)
  ) {
    throw new CodexEgressPolicyError('Codex egress credential is invalid');
  }
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${credential.accessToken}`);
  headers.set('chatgpt-account-id', credential.accountId);
  return { ...request, headers };
}
