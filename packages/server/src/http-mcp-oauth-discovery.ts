import { lookup } from 'node:dns';
import { request } from 'node:https';
import { z } from 'zod';
import { McpOAuthDiscoveryError } from './http-mcp-oauth-errors.js';
import { isIP } from 'node:net';
import {
  isInternalMcpUpstreamAddress,
  parseHttpMcpUpstream,
  refusedMcpUpstreamRange,
} from './http-mcp-proxy.js';

const TLS_ERROR =
  /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_(?:VERIFY|GET_ISSUER)|HOSTNAME_MISMATCH)/u;

/**
 * A parsed MCP or OAuth URL. `label` names a URL a remote server supplied, so
 * its text is never echoed into the form; a URL the user typed is quoted back.
 * Messages about remote URLs name only their host, which cannot carry prose;
 * the path goes to the server log.
 */
function upstreamUrl(value: string, label?: string): URL {
  try {
    return parseHttpMcpUpstream(value);
  } catch {
    throw new McpOAuthDiscoveryError(
      'invalid_url',
      `${label ?? value.slice(0, 300)} is not a usable HTTPS URL. Use https:// without credentials or a fragment, and not a loopback or link-local address.`,
    );
  }
}

/** The user's MCP server URL, rejected with the same `invalid_url` step as discovery. */
export function parseMcpServerUrl(value: string): URL {
  return upstreamUrl(value);
}

function internalRefusal(host: string, address: string): McpOAuthDiscoveryError {
  return new McpOAuthDiscoveryError(
    'address_refused',
    `${host} resolves to the internal address ${address}, but the MCP server URL is public. OAuth endpoints of a public MCP server may not point into an internal network.`,
    { host, address, range: 'internal' },
  );
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

/**
 * Whether the MCP server behind `url` is on a private network or the tailnet.
 * Token requests use it to keep a public server's endpoints public after setup,
 * when the probe that classified the server is long gone. An unresolvable host
 * counts as public: the stricter answer, and its token request fails anyway.
 */
export async function mcpServerIsInternal(url: string): Promise<boolean> {
  const host = upstreamUrl(url).hostname.replace(/^\[(.*)\]$/u, '$1');
  if (isIP(host) !== 0) return isInternalMcpUpstreamAddress(host);
  return new Promise((resolve) => {
    lookup(host, { all: true, verbatim: true }, (error, addresses) =>
      resolve(
        // Every address, not any: a public server must not become "internal" by
        // adding one private record next to its public one.
        error === null &&
          addresses.length > 0 &&
          addresses.every(({ address }) => isInternalMcpUpstreamAddress(address)),
      ),
    );
  });
}

export interface OAuthHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
  /** Whether the peer was a private or tailnet address; undefined when unknown. */
  internal?: boolean;
}
/**
 * `allowInternal: false` refuses private and tailnet peers. Discovery passes it
 * once the MCP server itself turned out to be public, so a public server's
 * metadata cannot steer Verity's requests into the operator's network.
 */
export type OAuthHttpRequest = (
  url: string,
  body?: string,
  contentType?: string,
  authorization?: string,
  headersOnly?: boolean,
  allowInternal?: boolean,
) => Promise<OAuthHttpResponse>;

/** No redirects, cookies or ambient credentials; DNS is checked on the actual socket. */
export const oauthHttpRequest: OAuthHttpRequest = async (
  url,
  body,
  contentType,
  authorization,
  headersOnly,
  allowInternal = true,
) => {
  const target = upstreamUrl(url);
  const host = target.hostname;
  const literal = host.replace(/^\[(.*)\]$/u, '$1');
  // Node connects to an IP literal without calling the lookup hook below.
  let internal = isIP(literal) === 0 ? undefined : isInternalMcpUpstreamAddress(literal);
  if (internal === true && !allowInternal) throw internalRefusal(host, literal);
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
            const refused = addresses
              ?.map(({ address }) => ({ address, range: refusedMcpUpstreamRange(address) }))
              .find(({ range }) => range !== undefined);
            const internalAddress = addresses?.find(({ address }) =>
              isInternalMcpUpstreamAddress(address),
            )?.address;
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
            } else if (internalAddress !== undefined && !allowInternal) {
              callback(internalRefusal(host, internalAddress), []);
            } else {
              // Internal only when every answer is: a mixed answer may connect to
              // the public address, and must not unlock internal endpoints.
              internal = addresses.every(({ address }) => isInternalMcpUpstreamAddress(address));
              if (typeof options === 'object' && options.all) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            }
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
          resolve({ status, headers, body: '', ...(internal === undefined ? {} : { internal }) });
          response.destroy();
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024)
            response.destroy(
              new McpOAuthDiscoveryError('metadata_invalid', `${host} returned more than 1 MiB.`, {
                host,
                status,
              }),
            );
          else chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
            ...(internal === undefined ? {} : { internal }),
          }),
        );
      },
    );
    const timeout = setTimeout(
      () =>
        req.destroy(
          new McpOAuthDiscoveryError('timeout', `${host} did not answer within 15 seconds.`, {
            host,
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
  get: (url: string) => Promise<OAuthHttpResponse>,
  url: string,
  schema: T,
  what: string,
): Promise<z.infer<T> | undefined> {
  const parsed = upstreamUrl(url);
  const detail = { host: parsed.hostname };
  const response = await get(parsed.href);
  if (response.status === 404) return undefined;
  if (response.status !== 200)
    throw new McpOAuthDiscoveryError(
      'metadata_status',
      `${parsed.hostname} answered HTTP ${response.status} instead of ${what}.`,
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
      `${parsed.hostname} did not return valid ${what}${
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
      { host, status: probe.status },
    );
  // A public MCP server's metadata must stay public too; see OAuthHttpRequest.
  const get = (metadataUrl: string) =>
    probe.internal === false
      ? send(metadataUrl, undefined, undefined, undefined, false, false)
      : send(metadataUrl);
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
      : [upstreamUrl(advertised, `The resource_metadata URL advertised by ${host}`).href];
  let resource: z.infer<typeof resourceSchema> | undefined;
  for (const metadataUrl of metadataUrls) {
    resource = await readMetadata(get, metadataUrl, resourceSchema, 'protected-resource metadata');
    if (resource !== undefined) break;
  }
  if (resource === undefined)
    throw new McpOAuthDiscoveryError(
      'metadata_missing',
      advertised !== undefined
        ? `The protected-resource metadata advertised by ${host} was not found (HTTP 404).`
        : challenge === undefined
          ? `${target.href} answered HTTP ${probe.status} without an OAuth challenge, so Verity cannot tell how to sign in.`
          : `${target.href} answered HTTP ${probe.status} with an OAuth challenge that names no resource metadata, and none was found at the well-known paths.`,
      { host, status: probe.status },
    );
  if (resource.resource !== target.href)
    throw new McpOAuthDiscoveryError(
      'resource_mismatch',
      `The protected-resource metadata describes a different resource than ${target.href}.`,
      { host },
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
      get,
      metadataUrl,
      authorizationSchema,
      'OAuth authorization server metadata',
    );
    if (authority !== undefined) break;
  }
  const issuerDetail = { host: issuer.hostname };
  if (authority === undefined)
    throw new McpOAuthDiscoveryError(
      'metadata_missing',
      `No OAuth authorization server metadata was found at ${issuer.hostname} (HTTP 404 at every well-known path).`,
      issuerDetail,
    );
  if (authority.issuer !== issuer.href)
    throw new McpOAuthDiscoveryError(
      'issuer_mismatch',
      `The authorization server metadata at ${issuer.hostname} names a different issuer than ${host} declared.`,
      issuerDetail,
    );
  if (!authority.code_challenge_methods_supported?.includes('S256'))
    throw new McpOAuthDiscoveryError(
      'pkce_unsupported',
      `The OAuth server ${issuer.hostname} does not offer PKCE with S256.`,
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
      `The OAuth server ${issuer.hostname} does not support the authorization code flow.`,
      issuerDetail,
    );
  const scopes =
    challengeParameter(challenge, 'scope') ?? resource.scopes_supported?.join(' ') ?? '';
  return {
    authority,
    /** False when the MCP server is public; registration then stays public too. */
    ...(probe.internal === undefined ? {} : { internal: probe.internal }),
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
  allowInternal = true,
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
  const detail = { host: registrationUrl.hostname };
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
  const payload = JSON.stringify({
    client_name: 'Verity',
    redirect_uris: redirectUris,
    grant_types: authority.grant_types_supported?.includes('refresh_token')
      ? ['authorization_code', 'refresh_token']
      : ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    ...(scopes === '' ? {} : { scope: scopes }),
  });
  const response = allowInternal
    ? await send(registration, payload)
    : await send(registration, payload, undefined, undefined, false, false);
  if (response.status !== 200 && response.status !== 201)
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      `Client registration at ${registrationUrl.hostname} answered HTTP ${response.status}. Check that the provider accepts the callback URLs, or configure a client manually.`,
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
      `Client registration at ${registrationUrl.hostname} returned an unreadable response.`,
      { ...detail, status: response.status },
    );
  const result = parsed.data;
  const missingRedirect = redirectUris.find(
    (uri) => result.redirect_uris !== undefined && !result.redirect_uris.includes(uri),
  );
  if (missingRedirect !== undefined)
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      `Client registration at ${registrationUrl.hostname} did not accept the callback URL ${missingRedirect}.`,
      { ...detail, status: response.status },
    );
  if (
    result.token_endpoint_auth_method !== undefined &&
    result.token_endpoint_auth_method !== method
  )
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      `Client registration at ${registrationUrl.hostname} returned a different client authentication method than requested (${method}).`,
      { ...detail, status: response.status },
    );
  if (method !== 'none' && result.client_secret === undefined)
    throw new McpOAuthDiscoveryError(
      'registration_failed',
      `Client registration at ${registrationUrl.hostname} returned no client secret for ${method}.`,
      { ...detail, status: response.status },
    );
  return {
    clientId: result.client_id,
    clientSecret: method === 'none' ? null : result.client_secret!,
    tokenAuthMethod: method,
  };
}
