import { describe, expect, it, vi } from 'vitest';
import {
  discoverMcpOAuth,
  registerMcpOAuthClient,
  type OAuthHttpResponse,
} from './http-mcp-oauth-discovery.js';

const resourceUrl = 'https://tools.example/mcp';
const issuer = 'https://identity.example/tenant';
const authority = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  response_types_supported: ['code'],
};
const resource = {
  resource: resourceUrl,
  authorization_servers: [issuer],
  scopes_supported: ['data:read'],
};
function response(
  value: unknown,
  status = 200,
  headers: OAuthHttpResponse['headers'] = {},
): OAuthHttpResponse {
  return { status, headers, body: JSON.stringify(value) };
}
function transport(resourceValue: unknown = resource, authorityValue: unknown = authority) {
  return vi.fn(async (url: string) => {
    if (url === resourceUrl)
      return response({}, 401, {
        'www-authenticate':
          'Bearer resource_metadata="https://tools.example/metadata", scope="data:write"',
      });
    if (url === 'https://tools.example/metadata') return response(resourceValue);
    if (url === 'https://identity.example/.well-known/oauth-authorization-server/tenant')
      return response(authorityValue);
    return response({}, 404);
  });
}

describe('generic MCP OAuth discovery', () => {
  it('follows the challenge and issuer metadata, prioritizing requested scopes without credentials', async () => {
    const send = transport();
    expect((await discoverMcpOAuth(resourceUrl, send)).discovery).toEqual({
      authorizationEndpoint: authority.authorization_endpoint,
      tokenEndpoint: authority.token_endpoint,
      scopes: 'data:write',
      registrationAvailable: true,
    });
    expect(send.mock.calls.map(([url]) => url)).toEqual([
      resourceUrl,
      'https://tools.example/metadata',
      'https://identity.example/.well-known/oauth-authorization-server/tenant',
    ]);
    expect(send).toHaveBeenNthCalledWith(1, resourceUrl, undefined, undefined, undefined, true);
    expect(send.mock.calls.slice(1).every((call) => call.length === 1)).toBe(true);
  });
  it('falls back to path and root resource metadata and OpenID discovery', async () => {
    const urls: string[] = [];
    const send = vi.fn(async (url: string) => {
      urls.push(url);
      if (url === 'https://tools.example/.well-known/oauth-protected-resource')
        return response(resource);
      if (url === 'https://identity.example/tenant/.well-known/openid-configuration')
        return response(authority);
      return response({}, 404);
    });
    expect((await discoverMcpOAuth(resourceUrl, send)).discovery.scopes).toBe('data:read');
    expect(urls).toContain('https://tools.example/.well-known/oauth-protected-resource/mcp');
    expect(urls).toContain('https://identity.example/.well-known/openid-configuration/tenant');
  });
  it.each([
    [{ ...resource, resource: 'https://other.example/mcp' }, authority],
    [resource, { ...authority, issuer: 'https://other.example' }],
    [resource, { ...authority, token_endpoint: 'http://private.example/token' }],
    [resource, { ...authority, authorization_endpoint: 'https://127.0.0.1/authorize' }],
    [resource, { ...authority, code_challenge_methods_supported: ['plain'] }],
    [resource, { ...authority, grant_types_supported: ['client_credentials'] }],
    [resource, { ...authority, response_types_supported: ['token'] }],
  ])('rejects mismatched or unsafe metadata', async (res, auth) => {
    await expect(discoverMcpOAuth(resourceUrl, transport(res, auth))).rejects.toThrow();
  });
  it('rejects redirects rather than following a new discovery target', async () => {
    const send = vi.fn(async () => response({}, 302, { location: 'https://internal.example' }));
    await expect(discoverMcpOAuth(resourceUrl, send)).rejects.toThrow(/redirect/u);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('explains the manual fallback when metadata is missing', async () => {
    await expect(discoverMcpOAuth(resourceUrl, async () => response({}, 404))).rejects.toThrow(
      /manually/u,
    );
  });
  it('registers exact native and web callbacks and keeps returned secrets private', async () => {
    const { authority: discovered } = await discoverMcpOAuth(resourceUrl, transport());
    const redirects = [
      'https://verity.build/mcp/oauth/callback',
      'https://my-host.example/app/mcp/oauth/callback',
    ];
    const send = vi.fn(async () =>
      response(
        { client_id: 'registered', redirect_uris: redirects, token_endpoint_auth_method: 'none' },
        201,
      ),
    );
    await expect(registerMcpOAuthClient(discovered, redirects, 'data:read', send)).resolves.toEqual(
      { clientId: 'registered', clientSecret: null, tokenAuthMethod: 'none' },
    );
    expect(send).toHaveBeenCalledWith(
      authority.registration_endpoint,
      JSON.stringify({
        client_name: 'Verity',
        redirect_uris: redirects,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'data:read',
      }),
    );
  });
  it('rejects incompatible registration metadata', async () => {
    const { authority: discovered } = await discoverMcpOAuth(resourceUrl, transport());
    await expect(
      registerMcpOAuthClient(
        discovered,
        ['https://verity.build/mcp/oauth/callback'],
        '',
        async () =>
          response({ client_id: 'client', redirect_uris: ['https://other.example'] }, 201),
      ),
    ).rejects.toThrow(/incompatible/u);
  });
});

it('supports confidential dynamically registered clients with basic authentication', async () => {
  const { authority: discovered } = await discoverMcpOAuth(
    resourceUrl,
    transport(resource, {
      ...authority,
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    }),
  );
  const send = vi.fn(async () =>
    response(
      {
        client_id: 'confidential',
        client_secret: 'secret',
        token_endpoint_auth_method: 'client_secret_basic',
      },
      201,
    ),
  );
  await expect(
    registerMcpOAuthClient(discovered, ['https://verity.build/mcp/oauth/callback'], '', send),
  ).resolves.toEqual({
    clientId: 'confidential',
    clientSecret: 'secret',
    tokenAuthMethod: 'client_secret_basic',
  });
});

it('registers only code grants when the provider does not advertise refresh support', async () => {
  const { authority: discovered } = await discoverMcpOAuth(
    resourceUrl,
    transport(resource, { ...authority, grant_types_supported: ['authorization_code'] }),
  );
  const send = vi.fn(async () =>
    response({ client_id: 'registered', token_endpoint_auth_method: 'none' }, 201),
  );
  await registerMcpOAuthClient(discovered, ['https://verity.build/mcp/oauth/callback'], '', send);
  expect(send).toHaveBeenCalledWith(
    authority.registration_endpoint,
    expect.stringContaining('"grant_types":["authorization_code"]'),
  );
});
