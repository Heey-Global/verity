import { createHash, randomBytes } from 'node:crypto';
import type { EventStore, HttpMcpConnectionRecord } from '@verity/store';
import { completeHttpMcpOAuth } from './http-mcp-oauth.js';
import { parseHttpMcpUpstream } from './http-mcp-proxy.js';

export const NATIVE_MCP_CALLBACK = 'https://verity.build/mcp/oauth/callback';
const WEB_MCP_CALLBACK_PATH = '/app/mcp/oauth/callback';
export type McpOAuthPlatform = 'web' | 'native' | 'native-staging';

export function mcpWebCallback(origin: string): string {
  const parsed = new URL(origin);
  if (
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.protocol !== 'https:' &&
      !(
        parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      ))
  ) {
    throw new Error(
      'Web OAuth requires HTTPS (or localhost). Use an HTTPS address such as your Tailscale HTTPS hostname.',
    );
  }
  return `${parsed.origin}${WEB_MCP_CALLBACK_PATH}`;
}

function configuration(connection: HttpMcpConnectionRecord): string {
  return JSON.stringify([
    connection.url,
    connection.authType,
    connection.oauthClientId,
    connection.oauthClientSecret,
    connection.oauthTokenAuthMethod,
    connection.oauthAuthorizationEndpoint,
    connection.oauthTokenEndpoint,
    connection.oauthScopes,
  ]);
}

interface PendingFlow {
  ownerId: string;
  connectionId: string;
  fingerprint: string;
  codeVerifier: string;
  redirectUri: string;
  platform: McpOAuthPlatform;
  origin: string;
  expiresAt: number;
}

/** Ephemeral by design: a server restart invalidates pending grants and requires reconnecting. */
export class McpOAuthFlows {
  private readonly pending = new Map<string, PendingFlow>();
  constructor(
    private readonly store: EventStore,
    private readonly complete = completeHttpMcpOAuth,
    private readonly now = Date.now,
  ) {}

  start(
    ownerId: string,
    connection: HttpMcpConnectionRecord,
    platform: McpOAuthPlatform,
    origin: string,
  ) {
    const now = this.now();
    for (const [key, flow] of this.pending) if (flow.expiresAt <= now) this.pending.delete(key);
    if (this.pending.size >= 1000)
      throw new Error('Too many pending OAuth sign-ins. Try again later.');
    // A repeated click invalidates its predecessor without affecting another user's flow.
    for (const [key, flow] of this.pending)
      if (flow.ownerId === ownerId && flow.connectionId === connection.id) this.pending.delete(key);
    if (
      connection.authType !== 'oauth' ||
      !connection.enabled ||
      !connection.oauthClientId ||
      !connection.oauthAuthorizationEndpoint ||
      !connection.oauthTokenEndpoint
    )
      throw new Error('The MCP OAuth configuration is incomplete');
    const redirectUri = platform === 'web' ? mcpWebCallback(origin) : NATIVE_MCP_CALLBACK;
    const codeVerifier = randomBytes(32).toString('base64url');
    const state = `${platform === 'native-staging' ? 'staging.' : ''}${randomBytes(32).toString('base64url')}`;
    const flow: PendingFlow = {
      ownerId,
      connectionId: connection.id,
      fingerprint: configuration(connection),
      codeVerifier,
      redirectUri,
      platform,
      origin,
      expiresAt: now + 10 * 60_000,
    };
    const authorizationUrl = parseHttpMcpUpstream(connection.oauthAuthorizationEndpoint);
    const params = {
      access_type: 'offline',
      prompt: 'consent',
      response_type: 'code',
      client_id: connection.oauthClientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: connection.url,
    };
    for (const [key, value] of Object.entries(params))
      authorizationUrl.searchParams.set(key, value);
    authorizationUrl.searchParams.delete('scope');
    if (connection.oauthScopes) authorizationUrl.searchParams.set('scope', connection.oauthScopes);
    this.pending.set(state, flow);
    return {
      authorizationUrl: authorizationUrl.href,
      state,
      redirectUri,
      expiresAt: flow.expiresAt,
    };
  }

  cancel(ownerId: string, connectionId: string, state: string): void {
    const flow = this.pending.get(state);
    if (flow?.ownerId === ownerId && flow.connectionId === connectionId) this.pending.delete(state);
  }

  async finish(
    ownerId: string,
    connection: HttpMcpConnectionRecord,
    input: { state: string; code: string },
    origin: string,
  ): Promise<void> {
    const flow = this.pending.get(input.state);
    if (flow === undefined || flow.ownerId !== ownerId || flow.connectionId !== connection.id)
      throw new Error('OAuth sign-in is missing. Reconnect OAuth.');
    // Consume before the first await: retries and concurrent callbacks cannot redeem twice.
    this.pending.delete(input.state);
    if (
      flow.expiresAt <= this.now() ||
      flow.fingerprint !== configuration(connection) ||
      !connection.enabled ||
      (flow.platform === 'web' && flow.origin !== origin)
    )
      throw new Error('OAuth sign-in expired or the connection changed. Reconnect OAuth.');
    await this.complete(this.store, connection, {
      code: input.code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
    });
  }
}
