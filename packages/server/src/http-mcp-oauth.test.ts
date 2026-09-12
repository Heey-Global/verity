import { describe, expect, it, vi } from 'vitest';

import type { EventStore, HttpMcpConnectionRecord } from '@verity/store';

import { completeHttpMcpOAuth, httpMcpAuthorization } from './http-mcp-oauth.js';

const connection: HttpMcpConnectionRecord = {
  id: 'gmail',
  name: 'gmail',
  url: 'https://gmailmcp.googleapis.com/mcp/v1',
  authorization: null,
  authType: 'oauth',
  oauthClientId: 'client-id',
  oauthClientSecret: 'client-secret',
  oauthAuthorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  oauthTokenEndpoint: 'https://oauth2.googleapis.com/token',
  oauthScopes: 'gmail.readonly gmail.compose',
  oauthAccessToken: null,
  oauthRefreshToken: 'refresh-token',
  oauthExpiresAt: new Date(0),
  enabled: true,
};

function oauthStore(update = vi.fn().mockResolvedValue(true)): EventStore {
  let current = connection;
  return {
    updateHttpMcpOAuthTokens: async (
      ...args: Parameters<EventStore['updateHttpMcpOAuthTokens']>
    ) => {
      const changed = (await update(...args)) as boolean;
      if (changed) {
        current = {
          ...current,
          oauthAccessToken: args[1].accessToken,
          oauthRefreshToken: args[1].refreshToken,
          oauthExpiresAt: args[1].expiresAt,
        };
      }
      return changed;
    },
    listHttpMcpConnections: vi.fn().mockImplementation(async () => [current]),
  } as unknown as EventStore;
}

describe('HTTP MCP OAuth', () => {
  it('exchanges a PKCE code without exposing tokens outside the store', async () => {
    const update = vi.fn().mockResolvedValue(true);
    const request = vi
      .fn()
      .mockResolvedValue({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    await completeHttpMcpOAuth(
      oauthStore(update),
      connection,
      {
        code: 'code',
        codeVerifier: 'v'.repeat(43),
        redirectUri: 'https://verity.build/mcp/oauth/callback',
      },
      request,
    );
    expect(Object.fromEntries(request.mock.calls[0]![1] as URLSearchParams)).toMatchObject({
      code: 'code',
      code_verifier: 'v'.repeat(43),
      client_secret: 'client-secret',
      resource: 'https://gmailmcp.googleapis.com/mcp/v1',
    });
    expect(update).toHaveBeenCalledWith(
      'gmail',
      expect.objectContaining({ accessToken: 'access', refreshToken: 'refresh' }),
    );
  });

  it('does not retain an earlier account refresh token on reconnect', async () => {
    const update = vi.fn().mockResolvedValue(true);
    await completeHttpMcpOAuth(
      oauthStore(update),
      connection,
      {
        code: 'code',
        codeVerifier: 'v'.repeat(43),
        redirectUri: 'https://verity.build/mcp/oauth/callback',
      },
      vi.fn().mockResolvedValue({ access_token: 'new-account-access', expires_in: 3600 }),
    );
    expect(update).toHaveBeenCalledWith('gmail', expect.objectContaining({ refreshToken: null }));
  });

  it('refuses to proxy an OAuth connection that has not been authorized', async () => {
    const unauthorized = { ...connection, oauthAccessToken: null, oauthRefreshToken: null };
    const store = {
      listHttpMcpConnections: vi.fn().mockResolvedValue([unauthorized]),
    } as unknown as EventStore;
    await expect(httpMcpAuthorization(store, unauthorized)).rejects.toThrow(/not authorized/u);
  });

  it('refreshes an expired access token before proxying', async () => {
    const update = vi.fn().mockResolvedValue(true);
    const request = vi.fn().mockResolvedValue({ access_token: 'fresh', expires_in: 3600 });
    await expect(httpMcpAuthorization(oauthStore(update), connection, request)).resolves.toBe(
      'Bearer fresh',
    );
    expect(Object.fromEntries(request.mock.calls[0]![1] as URLSearchParams)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      resource: 'https://gmailmcp.googleapis.com/mcp/v1',
    });
  });

  it('shares one refresh across concurrent proxy requests', async () => {
    const update = vi.fn().mockResolvedValue(true);
    const request = vi.fn().mockResolvedValue({ access_token: 'fresh', expires_in: '3600' });
    const store = oauthStore(update);
    await expect(
      Promise.all([
        httpMcpAuthorization(store, connection, request),
        httpMcpAuthorization(store, connection, request),
      ]),
    ).resolves.toEqual(['Bearer fresh', 'Bearer fresh']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('cannot refresh an old account over a concurrent reconnect', async () => {
    let current = connection;
    let releaseExchange = (): void => undefined;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const store = {
      listHttpMcpConnections: vi.fn(async () => [current]),
      updateHttpMcpOAuthTokens: vi.fn(
        async (
          _id: string,
          tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null },
        ) => {
          current = {
            ...current,
            oauthAccessToken: tokens.accessToken,
            oauthRefreshToken: tokens.refreshToken,
            oauthExpiresAt: tokens.expiresAt,
          };
          return true;
        },
      ),
    } as unknown as EventStore;
    const reconnect = completeHttpMcpOAuth(
      store,
      connection,
      {
        code: 'new-code',
        codeVerifier: 'v'.repeat(43),
        redirectUri: 'https://verity.build/mcp/oauth/callback',
      },
      vi.fn(async () => {
        await exchangeGate;
        return { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 };
      }),
    );
    const staleRefresh = vi.fn().mockResolvedValue({ access_token: 'old-account-access' });
    const authorization = httpMcpAuthorization(store, connection, staleRefresh);
    releaseExchange();
    await reconnect;
    await expect(authorization).resolves.toBe('Bearer new-access');
    expect(staleRefresh).not.toHaveBeenCalled();
  });

  it('reloads even a valid cached token after a concurrent reconnect', async () => {
    const current = {
      ...connection,
      oauthAccessToken: 'new-account-access',
      oauthRefreshToken: 'new-account-refresh',
      oauthExpiresAt: new Date(Date.now() + 3_600_000),
    };
    const store = {
      listHttpMcpConnections: vi.fn().mockResolvedValue([current]),
    } as unknown as EventStore;
    const stale = {
      ...connection,
      oauthAccessToken: 'old-account-access',
      oauthExpiresAt: new Date(Date.now() + 3_600_000),
    };
    await expect(httpMcpAuthorization(store, stale)).resolves.toBe('Bearer new-account-access');
  });

  it('fails closed when a connection is deleted during token exchange', async () => {
    const store = oauthStore(vi.fn().mockResolvedValue(false));
    await expect(
      completeHttpMcpOAuth(
        store,
        connection,
        {
          code: 'code',
          codeVerifier: 'v'.repeat(43),
          redirectUri: 'https://verity.build/mcp/oauth/callback',
        },
        vi.fn().mockResolvedValue({ access_token: 'orphaned' }),
      ),
    ).rejects.toThrow(/removed/u);
  });
});
