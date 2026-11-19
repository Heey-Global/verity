import { lookup } from 'node:dns';
import { request } from 'node:https';
import { z } from 'zod';
import { McpOAuthDiscoveryError } from './http-mcp-oauth-errors.js';
import { parseHttpMcpUpstream, refusedMcpUpstreamRange } from './http-mcp-proxy.js';

const TLS_ERROR =
  /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_(?:VERIFY|GET_ISSUER)|HOSTNAME_MISMATCH)/u;

/** A parsed MCP or OAuth URL; anything else is reported as the URL it was. */
function upstreamUrl(value: string): URL {
  try {
    return parseHttpMcpUpstream(value);
  } catch {
    throw new McpOAuthDiscoveryError(
      'invalid_url',
      `${value.slice(0, 300)} is not a usable HTTPS URL. Use https:// without credentials or a fragment, and not a loopback or link-local address.`,
    );
  }
}

function transportError(error: unknown, target: URL): McpOAuthDiscoveryError {
  if (error instanceof McpOAuthDiscoveryError) return error;
  const host = target.hostname;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TLS_ERROR.test(code))
    return new McpOAuthDiscoveryError(
      'tls_failed',
      `The TLS certificate of ${host} could not be verified (${code}).`,
      { host },
    );
  return new McpOAuthDiscoveryError(
    'connect_failed',
    `The Verity server could not connect to ${host}${typeof code === 'string' ? ` (${code})` : ''}.`,
    { host },
  );
}

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
  headersOnly?: boolean,
) => Promise<OAuthHttpResponse>;

/** No redirects, cookies or ambient credentials; DNS is checked on the actual socket. */
export const oauthHttpRequest: OAuthHttpRequest = async (
  url,
  body,
  contentType,
  authorization,
  headersOnly,
) => {
  const target = upstreamUrl(url);
  return new Promise((resolve, reject) => {
    const host = target.hostname;
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
            const refused = addresses
              ?.map(({ address }) => ({ address, range: refusedMcpUpstreamRange(address) }))
              .find(({ range }) => range !== undefined);
            if (error !== null || addresses.length === 0) {
              callback(
                new McpOAuthDiscoveryError(
                  'dns_failed',
                  `The Verity server could not resolve ${host}${error?.code ? ` (${error.code})` : ''}.`,
                  { host },
                ),
                [],
              );
            } else if (refused !== undefined) {
              callback(
                new McpOAuthDiscoveryError(
                  'address_refused',
                  `${host} resolves to ${refused.address} (${refused.range}), which MCP connections may not reach.`,
                  { host, address: refused.address, range: refused.range! },
                ),
                [],
              );
            } else if (typeof options === 'object' && options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      },
      (response) => {
        response.on('error', (error) => reject(transportError(error, target)));
        const status = response.statusCode ?? 500;
        const headers = Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(', ') : value,
          ]),
        );
        // A Streamable HTTP GET can remain open indefinitely. Discovery needs
        // only its challenge headers, so release the socket before reading data.
        if (headersOnly) {
          resolve({ status, headers, body: '' });
          response.destroy();
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024)
            response.destroy(
              new McpOAuthDiscoveryError(
                'metadata_invalid',
                `${target.href} returned more than 1 MiB.`,
                { host, path: target.pathname, status },
              ),
            );
          else chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    const timeout = setTimeout(
      () =>
        req.destroy(
          new McpOAuthDiscoveryError('timeout', `${host} did not answer within 15 seconds.`, {
            host,
            path: target.pathname,
          }),
        ),
      15_000,
    );
    timeout.unref();
    req.on('error', (error) => reject(transportError(error, target)));
    req.on('close', () => clearTimeout(timeout));
    req.end(body);
  });
};

const publicEndpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      parseHttpMcpUpstream(value);
      return true;
    } catch {
      return false;
    }
  }, 'must be an HTTPS URL Verity may reach')
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
interface McpOAuthDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string;
  registrationAvailable: boolean;
}

function challengeParameter(header: string | undefined, parameter: string): string | undefined {
  if (header === undefined || !/\bBearer\s/iu.test(header)) return undefined;
  return new RegExp(`\\b${parameter}="([^"\\\\]*)"`, 'iu').exec(header)?.[1];
}

/** Reads one metadata document; a 404 means "try the next candidate". */
async function readMetadata<T extends z.ZodType>(
  send: OAuthHttpRequest,
  url: string,
  schema: T,
  what: string,
): Promise<z.infer<T> | undefined> {
  const parsed = upstreamUrl(url);
  const detail = { host: parsed.hostname, path: parsed.pathname };
  const response = await send(parsed.href);
  if (response.status === 404) return undefined;
  if (response.status !== 200)
    throw new McpOAuthDiscoveryError(
      'metadata_status',
      `${parsed.href} answered HTTP ${response.status} instead of ${what}.`,
      { ...detail, status: response.status },
    );
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    body = undefined;
  }
  const result = schema.safeParse(body);
  if (!result.success)
    throw new McpOAuthDiscoveryError(
      'metadata_invalid',
      `${parsed.href} did not return valid ${what}${
        result.error.issues[0]?.path.length
          ? ` (field ${result.error.issues[0].path.map(String).join('.')})`
          : ''
      }.`,
      { ...detail, status: response.status },
    );
  return result.data;
}

export async function discoverMcpOAuth(url: string, send: OAuthHttpRequest = oauthHttpRequest) {
  const target = upstreamUrl(url);
  const host = target.hostname;
  const probe = await send(target.href, undefined, undefined, undefined, true);
  if (probe.status >= 300 && probe.status < 400)
    throw new McpOAuthDiscoveryError(
      'redirect',
      `${target.href} redirects (HTTP ${probe.status}). Enter the final MCP URL instead.`,
      { host, path: target.pathname, status: probe.status },
    );
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
      : [upstreamUrl(advertised).href];
  let resource: z.infer<typeof resourceSchema> | undefined;
  for (const metadataUrl of metadataUrls) {
    resource = await readMetadata(send, metadataUrl, resourceSchema, 'protected-resource metadata');
    if (resource !== undefined) break;
  }
  if (resource === undefined)
    throw new McpOAuthDiscoveryError(
      'metadata_missing',
      advertised === undefined
        ? `${target.href} answered HTTP ${probe.status} without an OAuth challenge, so Verity cannot tell how to sign in.`
        : `The protected-resource metadata ${metadataUrls[0]} named by ${host} was not found (HTTP 404).`,
      { host, path: target.pathname, status: probe.status },
    );
  if (resource.resource !== target.href)
    throw new McpOAuthDiscoveryError(
      'resource_mismatch',
      `The protected-resource metadata describes ${resource.resource.slice(0, 300)}, not ${target.href}.`,
      { host, path: target.pathname },
    );
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
    authority = await readMetadata(
      send,
      metadataUrl,
      authorizationSchema,
      'OAuth authorization server metadata',
    );
    if (authority !== undefined) break;
  }
  const issuerDetail = { host: issuer.hostname, path: issuer.pathname };
  if (authority === undefined)
    throw new McpOAuthDiscoveryError(
      'metadata_missing',
      `No OAuth authorization server metadata was found for ${issuer.href} (HTTP 404 at every well-known path).`,
      issuerDetail,
    );
  if (authority.issuer !== issuer.href)
    throw new McpOAuthDiscoveryError(
      'issuer_mismatch',
      `The authorization server metadata names issuer ${authority.issuer.slice(0, 300)}, not ${issuer.href}.`,
      issuerDetail,
    );
  if (!authority.code_challenge_methods_supported?.includes('S256'))
    throw new McpOAuthDiscoveryError(
      'pkce_unsupported',
      `The OAuth server ${issuer.href} does not offer PKCE with S256.`,
      issuerDetail,
    );
  if (
    (authority.grant_types_supported !== undefined &&
      !authority.grant_types_supported.includes('authorization_code')) ||
    (authority.response_types_supported !== undefined &&
      !authority.response_types_supported.includes('code'))
  )
    throw new McpOAuthDiscoveryError(
      'grant_unsupported',
      `The OAuth server ${issuer.href} does not support the authorization code flow.`,
      issuerDetail,
    );
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
  const registration = authority.registration_endpoint;
  if (registration === undefined)
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      'This provider requires an OAuth client ID. Register an application with the displayed callback URL.',
    );
  const registrationUrl = new URL(registration);
  const detail = { host: registrationUrl.hostname, path: registrationUrl.pathname };
  const supported = authority.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  const method = supported.includes('none')
    ? 'none'
    : supported.includes('client_secret_post')
      ? 'client_secret_post'
      : supported.includes('client_secret_basic')
        ? 'client_secret_basic'
        : undefined;
  if (method === undefined)
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      'Automatic registration is unavailable for this token authentication method. Configure a client manually.',
      detail,
    );
  const response = await send(
    registration,
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
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      `Client registration at ${registration} answered HTTP ${response.status}. Check that the provider accepts the callback URLs, or configure a client manually.`,
      { ...detail, status: response.status },
    );
  let registered: unknown;
  try {
    registered = JSON.parse(response.body);
  } catch {
    registered = undefined;
  }
  const parsed = z
    .object({
      client_id: z.string().min(1).max(512),
      client_secret: z.string().min(1).max(4096).optional(),
      redirect_uris: z.array(z.string()).optional(),
      token_endpoint_auth_method: z.string().optional(),
    })
    .safeParse(registered);
  if (!parsed.success)
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      `Client registration at ${registration} returned an unreadable response.`,
      { ...detail, status: response.status },
    );
  const result = parsed.data;
  const missingRedirect = redirectUris.find(
    (uri) => result.redirect_uris !== undefined && !result.redirect_uris.includes(uri),
  );
  if (missingRedirect !== undefined)
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      `Client registration at ${registration} did not accept the callback URL ${missingRedirect}.`,
      { ...detail, status: response.status },
    );
  if (
    (result.token_endpoint_auth_method !== undefined &&
      result.token_endpoint_auth_method !== method) ||
    (method !== 'none' && result.client_secret === undefined)
  )
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      `Client registration at ${registration} returned a different client authentication method than requested (${method}).`,
      { ...detail, status: response.status },
    );
  return {
    clientId: result.client_id,
    clientSecret: method === 'none' ? null : result.client_secret!,
    tokenAuthMethod: method,
  };
}
