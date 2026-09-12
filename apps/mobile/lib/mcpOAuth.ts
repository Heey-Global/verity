import type { HttpMcpConnection } from '@verity/mobile';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

void WebBrowser.maybeCompleteAuthSession();

const MCP_OAUTH_REDIRECT_URI = 'https://verity.build/mcp/oauth/callback';

export function isOfficialGmailMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'gmailmcp.googleapis.com' &&
      url.port === '' &&
      url.pathname === '/mcp/v1' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export async function runMcpOAuth(
  connection: HttpMcpConnection,
): Promise<
  | { kind: 'success'; code: string; codeVerifier: string; redirectUri: string }
  | { kind: 'cancelled' }
> {
  if (
    connection.oauthClientId === null ||
    connection.oauthAuthorizationEndpoint === null ||
    connection.oauthTokenEndpoint === null ||
    connection.oauthScopes === null
  ) {
    throw new Error('The MCP OAuth configuration is incomplete');
  }
  const discovery: AuthSession.DiscoveryDocument = {
    authorizationEndpoint: connection.oauthAuthorizationEndpoint,
    tokenEndpoint: connection.oauthTokenEndpoint,
  };
  const request = new AuthSession.AuthRequest({
    clientId: connection.oauthClientId,
    scopes: connection.oauthScopes.split(/\s+/u).filter(Boolean),
    redirectUri: MCP_OAUTH_REDIRECT_URI,
    usePKCE: true,
    responseType: AuthSession.ResponseType.Code,
    extraParams: { access_type: 'offline', prompt: 'consent', resource: connection.url },
  });
  await request.makeAuthUrlAsync(discovery);
  const result = await request.promptAsync(discovery, { preferEphemeralSession: false });
  if (result.type !== 'success' || typeof result.params.code !== 'string') {
    return { kind: 'cancelled' };
  }
  if (request.codeVerifier === undefined) throw new Error('OAuth did not produce a PKCE verifier');
  return {
    kind: 'success',
    code: result.params.code,
    codeVerifier: request.codeVerifier,
    redirectUri: MCP_OAUTH_REDIRECT_URI,
  };
}
