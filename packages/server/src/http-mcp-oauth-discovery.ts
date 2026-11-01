import { lookup } from 'node:dns';
import { request } from 'node:https';
import { z } from 'zod';
import { isForbiddenHttpMcpAddress, parseHttpMcpUpstream } from './http-mcp-proxy.js';

export interface OAuthHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}
export type OAuthHttpRequest = (
  url: string,
  body?: string,
  contentType?: string,
  authorization?: string,
) => Promise<OAuthHttpResponse>;

/** No redirects, cookies or ambient credentials; DNS is checked on the actual socket. */
export const oauthHttpRequest: OAuthHttpRequest = async (url, body, contentType, authorization) => {
  const target = parseHttpMcpUpstream(url);
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: body === undefined ? 'GET' : 'POST',
        agent: false,
        headers: {
          accept: 'application/json, text/event-stream',
          ...(authorization === undefined ? {} : { authorization }),
          ...(body === undefined
            ? {}
            : {
                'content-type': contentType ?? 'application/json',
                'content-length': String(Buffer.byteLength(body)),
              }),
        },
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (
              error !== null ||
              addresses.length === 0 ||
              addresses.some(({ address }) => isForbiddenHttpMcpAddress(address))
            ) {
              callback(new Error('MCP OAuth endpoint resolution rejected'), []);
            } else if (typeof options === 'object' && options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('error', reject);
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) response.destroy(new Error('MCP OAuth response too large'));
          else chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 500,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(', ') : value,
              ]),
            ),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    const timeout = setTimeout(() => req.destroy(new Error('MCP OAuth request timed out')), 15_000);
    timeout.unref();
    req.on('error', reject);
    req.on('close', () => clearTimeout(timeout));
    req.end(body);
  });
};

const publicEndpoint = z
  .string()
  .max(2048)
  .transform((value) => parseHttpMcpUpstream(value).href);
const resourceSchema = z.object({
  resource: publicEndpoint,
  authorization_servers: z.array(publicEndpoint).min(1).max(10),
  scopes_supported: z.array(z.string().min(1).max(512)).max(100).optional(),
});
const authorizationSchema = z.object({
  issuer: publicEndpoint,
  authorization_endpoint: publicEndpoint,
  token_endpoint: publicEndpoint,
  registration_endpoint: publicEndpoint.optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()).optional(),
});
export interface McpOAuthDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string;
  registrationAvailable: boolean;
}

function challengeParameter(header: string | undefined, parameter: string): string | undefined {
  if (header === undefined || !/\bBearer\s/iu.test(header)) return undefined;
  return new RegExp(`\\b${parameter}="([^"\\\\]*)"`, 'iu').exec(header)?.[1];
}

export async function discoverMcpOAuth(url: string, send: OAuthHttpRequest = oauthHttpRequest) {
  const target = parseHttpMcpUpstream(url);
  const probe = await send(target.href);
  if (probe.status >= 300 && probe.status < 400)
    throw new Error('MCP discovery redirects are not supported');
  const challenge = probe.headers['www-authenticate'];
  const advertised = challengeParameter(challenge, 'resource_metadata');
  const metadataUrls =
    advertised === undefined
      ? [
          ...new Set([
            `${target.origin}/.well-known/oauth-protected-resource${target.pathname === '/' ? '' : target.pathname}`,
            `${target.origin}/.well-known/oauth-protected-resource`,
          ]),
        ]
      : [parseHttpMcpUpstream(advertised).href];
  let resource: z.infer<typeof resourceSchema> | undefined;
  for (const metadataUrl of metadataUrls) {
    const response = await send(metadataUrl);
    if (response.status === 404) continue;
    if (response.status !== 200) throw new Error('MCP resource metadata could not be loaded');
    resource = resourceSchema.parse(JSON.parse(response.body));
    break;
  }
  if (resource === undefined)
    throw new Error('OAuth discovery is unavailable. Configure OAuth manually.');
  if (resource.resource !== target.href)
    throw new Error('MCP resource metadata does not match the server URL');
  // Use the first declared authority consistently; never silently switch accounts or issuers.
  const issuer = new URL(resource.authorization_servers[0]!);
  const path = issuer.pathname.replace(/\/$/u, '');
  const metadataUrlsForIssuer = [
    ...new Set([
      `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuer.origin}/.well-known/openid-configuration${path}`,
      `${issuer.origin}${path}/.well-known/openid-configuration`,
    ]),
  ];
  let authority: z.infer<typeof authorizationSchema> | undefined;
  for (const metadataUrl of metadataUrlsForIssuer) {
    const response = await send(metadataUrl);
    if (response.status === 404) continue;
    if (response.status !== 200) throw new Error('OAuth server metadata could not be loaded');
    authority = authorizationSchema.parse(JSON.parse(response.body));
    break;
  }
  if (authority === undefined || authority.issuer !== issuer.href)
    throw new Error('OAuth issuer metadata does not match');
  if (!authority.code_challenge_methods_supported?.includes('S256'))
    throw new Error('OAuth server must support PKCE S256');
  if (
    authority.grant_types_supported !== undefined &&
    !authority.grant_types_supported.includes('authorization_code')
  )
    throw new Error('OAuth server must support authorization code grants');
  if (
    authority.response_types_supported !== undefined &&
    !authority.response_types_supported.includes('code')
  )
    throw new Error('OAuth server must support code responses');
  const scopes =
    challengeParameter(challenge, 'scope') ?? resource.scopes_supported?.join(' ') ?? '';
  return {
    authority,
    discovery: {
      authorizationEndpoint: authority.authorization_endpoint,
      tokenEndpoint: authority.token_endpoint,
      scopes,
      registrationAvailable: authority.registration_endpoint !== undefined,
    } satisfies McpOAuthDiscovery,
  };
}

export async function registerMcpOAuthClient(
  authority: Awaited<ReturnType<typeof discoverMcpOAuth>>['authority'],
  redirectUris: string[],
  scopes: string,
  send: OAuthHttpRequest = oauthHttpRequest,
): Promise<{
  clientId: string;
  clientSecret: string | null;
  tokenAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
}> {
  if (authority.registration_endpoint === undefined)
    throw new Error(
      'This provider requires an OAuth client ID. Register an application with the displayed callback URL.',
    );
  const supported = authority.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  const method = supported.includes('none')
    ? 'none'
    : supported.includes('client_secret_post')
      ? 'client_secret_post'
      : supported.includes('client_secret_basic')
        ? 'client_secret_basic'
        : undefined;
  if (method === undefined)
    throw new Error(
      'Automatic registration is unavailable for this token authentication method. Configure a client manually.',
    );
  const response = await send(
    authority.registration_endpoint,
    JSON.stringify({
      client_name: 'Verity',
      redirect_uris: redirectUris,
      grant_types: authority.grant_types_supported?.includes('refresh_token')
        ? ['authorization_code', 'refresh_token']
        : ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      ...(scopes === '' ? {} : { scope: scopes }),
    }),
  );
  if (response.status !== 200 && response.status !== 201)
    throw new Error('OAuth client registration failed. Configure a client manually.');
  const result = z
    .object({
      client_id: z.string().min(1).max(512),
      client_secret: z.string().min(1).max(4096).optional(),
      redirect_uris: z.array(z.string()).optional(),
      token_endpoint_auth_method: z.string().optional(),
    })
    .parse(JSON.parse(response.body));
  if (
    (result.token_endpoint_auth_method !== undefined &&
      result.token_endpoint_auth_method !== method) ||
    (method !== 'none' && result.client_secret === undefined) ||
    (result.redirect_uris !== undefined &&
      redirectUris.some((uri) => !result.redirect_uris!.includes(uri)))
  )
    throw new Error('OAuth registration returned incompatible client metadata');
  return {
    clientId: result.client_id,
    clientSecret: method === 'none' ? null : result.client_secret!,
    tokenAuthMethod: method,
  };
}
