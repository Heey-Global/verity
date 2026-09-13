import { z } from 'zod';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';

import type { EventStore, HttpMcpConnectionRecord } from '@verity/store';

import { isForbiddenHttpMcpAddress, parseHttpMcpUpstream } from './http-mcp-proxy.js';

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
) => Promise<z.infer<typeof tokenResponseSchema>>;

async function tokenRequest(url: string, body: URLSearchParams) {
  const parsed = new URL(endpoint(url));
  const encoded = body.toString();
  const raw = await new Promise<string>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: parsed.hostname,
        port: 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        servername: parsed.hostname,
        agent: false,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'content-length': String(Buffer.byteLength(encoded)),
        },
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (
              error !== null ||
              addresses.length === 0 ||
              addresses.some((item) => isForbiddenHttpMcpAddress(item.address))
            ) {
              callback(new Error('MCP OAuth endpoint resolution rejected'), []);
            } else if (typeof options === 'object' && options.all) {
              callback(null, addresses);
            } else {
              const first = addresses[0]!;
              callback(null, first.address, first.family);
            }
          });
        },
      },
      (response) => {
        let value = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          value += chunk;
          if (value.length > 1024 * 1024)
            response.destroy(new Error('MCP OAuth response too large'));
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 300)
            reject(new Error(`MCP OAuth token exchange failed (${response.statusCode ?? 500})`));
          else resolve(value);
        });
      },
    );
    request.setTimeout(60_000, () =>
      request.destroy(new Error('MCP OAuth token endpoint timed out')),
    );
    request.on('error', reject);
    request.end(encoded);
  });
  return tokenResponseSchema.parse(JSON.parse(raw));
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
    if (connection.oauthClientSecret != null)
      body.set('client_secret', connection.oauthClientSecret);
    const token = await requestToken(endpoint(connection.oauthTokenEndpoint), body);
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
      throw new Error('MCP OAuth connection is not authorized');
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.oauthRefreshToken,
      client_id: current.oauthClientId,
      resource: current.url,
    });
    if (current.oauthClientSecret != null) body.set('client_secret', current.oauthClientSecret);
    const token = await requestToken(endpoint(current.oauthTokenEndpoint), body);
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
