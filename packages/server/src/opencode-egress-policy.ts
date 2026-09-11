export const OPENCODE_EGRESS_ORIGIN = 'https://opencode-gateway.invalid';
export const OPENCODE_EGRESS_PLACEHOLDER = 'verity-opencode-gateway-placeholder-v1';

const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  'cookie',
  'openai-organization',
  'openai-project',
  'proxy-authorization',
  'x-api-key',
]);
const ROUTES = new Map<string, string>([
  ['models', 'GET'],
  ['chat/completions', 'POST'],
  ['responses', 'POST'],
]);

export class OpenCodeEgressPolicyError extends Error {}

export interface ValidatedOpenCodeEgress {
  method: string;
  url: URL;
  headers: Headers;
  redirect: 'manual';
}

export function validateOpenCodeEgress(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  baseUrl: string;
}): ValidatedOpenCodeEgress {
  if (input.url.origin !== OPENCODE_EGRESS_ORIGIN || input.url.username || input.url.password) {
    throw new OpenCodeEgressPolicyError('OpenCode egress origin is not allowed');
  }
  if (!input.url.pathname.startsWith('/opencode/')) {
    throw new OpenCodeEgressPolicyError('OpenCode egress route is not allowed');
  }
  if (!['GET', 'POST'].includes(input.method)) {
    throw new OpenCodeEgressPolicyError('OpenCode egress method is not allowed');
  }
  const base = new URL(input.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new OpenCodeEgressPolicyError('OpenCode upstream URL is invalid');
  }
  const relativePath = input.url.pathname.slice('/opencode/'.length);
  if (ROUTES.get(relativePath) !== input.method || input.url.search !== '') {
    throw new OpenCodeEgressPolicyError('OpenCode egress route is not allowed');
  }
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const url = new URL(base);
  url.pathname = `${basePath}${relativePath}`.replace(/\/+/gu, '/');
  url.search = input.url.search;

  const headers = new Headers();
  let placeholderSeen = false;
  for (const [rawName, value] of Object.entries(input.headers)) {
    const name = rawName.toLowerCase();
    if (/[\r\n]/u.test(value)) throw new OpenCodeEgressPolicyError('OpenCode header is invalid');
    if (name === 'authorization') {
      if (value !== `Bearer ${OPENCODE_EGRESS_PLACEHOLDER}`) {
        throw new OpenCodeEgressPolicyError('OpenCode placeholder credential is invalid');
      }
      placeholderSeen = true;
      continue;
    }
    if (FORBIDDEN_CREDENTIAL_HEADERS.has(name)) {
      throw new OpenCodeEgressPolicyError('OpenCode credential header is not allowed');
    }
    headers.set(name, value);
  }
  if (!placeholderSeen) {
    throw new OpenCodeEgressPolicyError('OpenCode placeholder credential is missing');
  }
  return { method: input.method, url, headers, redirect: 'manual' };
}

export function injectOpenCodeCredential(
  request: ValidatedOpenCodeEgress,
  apiKey: string,
): ValidatedOpenCodeEgress {
  if (apiKey.length === 0 || /[\r\n]/u.test(apiKey)) {
    throw new OpenCodeEgressPolicyError('OpenCode credential is invalid');
  }
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${apiKey}`);
  return { ...request, headers };
}
