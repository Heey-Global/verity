import { z } from 'zod';

import type { EventStore, HttpMcpConnectionRecord } from '@verity/store';

import { parseHttpMcpUpstream } from './http-mcp-proxy.js';
import { oauthHttpRequest } from './http-mcp-oauth-discovery.js';
import { McpOAuthAuthorizationRequired } from './http-mcp-oauth-errors.js';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive().optional(),
});
const connectionLocks = new WeakMap<EventStore, Map<string, Promise<void>>>();

async function withConnectionLock<T>(
  store: EventStore,
  connectionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let locks = connectionLocks.get(store);
  if (locks === undefined) {
    locks = new Map();
    connectionLocks.set(store, locks);
  }
  const predecessor = locks.get(connectionId) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.catch(() => undefined).then(() => gate);
  locks.set(connectionId, tail);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(connectionId) === tail) locks.delete(connectionId);
  }
}

function endpoint(value: string | null | undefined): string {
  if (value === null || value === undefined) throw new Error('MCP OAuth endpoint is missing');
  return parseHttpMcpUpstream(value).toString();
}

type TokenRequest = (
  url: string,
  body: URLSearchParams,
  authorization?: string,
) => Promise<z.infer<typeof tokenResponseSchema>>;

async function tokenRequest(url: string, body: URLSearchParams, authorization?: string) {
  const response = await oauthHttpRequest(
    endpoint(url),
    body.toString(),
    'application/x-www-form-urlencoded',
    authorization,
  );
  if (response.status === 401 || response.status === 403) throw new McpOAuthAuthorizationRequired();
  if (response.status >= 300) {
    let error: unknown;
    try {
      error = JSON.parse(response.body);
    } catch {
      /* Upstream errors need not contain JSON. */
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'error' in error &&
      (error.error === 'invalid_grant' ||
        error.error === 'invalid_client' ||
        error.error === 'unauthorized_client')
    ) {
      throw new McpOAuthAuthorizationRequired();
    }
    throw new Error('MCP OAuth token endpoint is unavailable');
  }
  return tokenResponseSchema.parse(JSON.parse(response.body));
}

function clientAuthorization(
  connection: HttpMcpConnectionRecord,
  body: URLSearchParams,
): string | undefined {
  if (connection.oauthTokenAuthMethod === 'client_secret_basic') {
    if (connection.oauthClientId == null || connection.oauthClientSecret == null)
      throw new McpOAuthAuthorizationRequired();
    // RFC 6749 requires form-encoding each component before joining with a colon.
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    body.delete('client_id');
    return `Basic ${Buffer.from(`${encode(connection.oauthClientId)}:${encode(connection.oauthClientSecret)}`).toString('base64')}`;
  }
  if (connection.oauthTokenAuthMethod !== 'none' && connection.oauthClientSecret != null)
    body.set('client_secret', connection.oauthClientSecret);
  return undefined;
}

function expiry(expiresIn: number | undefined): Date | null {
  return expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1000);
}

export async function completeHttpMcpOAuth(
  store: EventStore,
  connection: HttpMcpConnectionRecord,
  input: { code: string; codeVerifier: string; redirectUri: string },
  requestToken: TokenRequest = tokenRequest,
): Promise<void> {
  await withConnectionLock(store, connection.id, async () => {
    if (connection.authType !== 'oauth' || connection.oauthClientId == null) {
      throw new Error('MCP connection does not use OAuth');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: connection.oauthClientId,
      resource: connection.url,
    });
    const authorization = clientAuthorization(connection, body);
    const token = await requestToken(endpoint(connection.oauthTokenEndpoint), body, authorization);
    if (
      !(await store.updateHttpMcpOAuthTokens(connection.id, {
        accessToken: token.access_token,
        // A reconnect changes account authority. Never retain a refresh token from
        // the previous grant when the new authorization returns none.
        refreshToken: token.refresh_token ?? null,
        expiresAt: expiry(token.expires_in),
      }))
    ) {
      throw new Error('MCP connection was removed during OAuth authorization');
    }
  });
}

export async function httpMcpAuthorization(
  store: EventStore,
  connection: HttpMcpConnectionRecord,
  requestToken: TokenRequest = tokenRequest,
): Promise<string | undefined> {
  if (connection.authType === 'none') return undefined;
  if (connection.authType !== 'oauth') return connection.authorization ?? undefined;
  return withConnectionLock(store, connection.id, async () => {
    const current = (await store.listHttpMcpConnections()).find(
      (candidate) => candidate.id === connection.id,
    );
    if (current === undefined || current.authType !== 'oauth') {
      throw new Error('MCP OAuth connection is unavailable');
    }
    const currentExpiry = current.oauthExpiresAt?.getTime() ?? 0;
    if (
      current.oauthAccessToken != null &&
      (currentExpiry === 0 || currentExpiry > Date.now() + 60_000)
    ) {
      return `Bearer ${current.oauthAccessToken}`;
    }
    if (current.oauthRefreshToken == null || current.oauthClientId == null) {
      throw new McpOAuthAuthorizationRequired();
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.oauthRefreshToken,
      client_id: current.oauthClientId,
      resource: current.url,
    });
    const authorization = clientAuthorization(current, body);
    const token = await requestToken(endpoint(current.oauthTokenEndpoint), body, authorization);
    if (
      !(await store.updateHttpMcpOAuthTokens(current.id, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? current.oauthRefreshToken,
        expiresAt: expiry(token.expires_in),
      }))
    ) {
      throw new Error('MCP connection was removed during OAuth refresh');
    }
    return `Bearer ${token.access_token}`;
  });
}
