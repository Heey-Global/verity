import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EventStore, HttpMcpConnectionRecord } from '@verity/store';
import { McpOAuthFlows, mcpWebCallback } from './http-mcp-oauth-flows.js';
const connection: HttpMcpConnectionRecord = {
  id: 'tools',
  ownerUserId: 'owner',
  name: 'tools',
  url: 'https://tools.example/mcp',
  enabled: true,
  authorization: null,
  authType: 'oauth',
  oauthClientId: 'client',
  oauthClientSecret: 'secret',
  oauthAuthorizationEndpoint: 'https://identity.example/authorize',
  oauthTokenEndpoint: 'https://identity.example/token',
  oauthScopes: 'read,write',
};
const origin = 'https://host.tail.example';
function harness() {
  const complete = vi.fn(async () => undefined);
  let now = 1_000;
  const flows = new McpOAuthFlows({} as EventStore, complete, () => now);
  return {
    flows,
    complete,
    expire: () => {
      now += 10 * 60_000;
    },
  };
}
describe('server-bound MCP OAuth flows', () => {
  it('binds the exact web callback, state, scopes and PKCE to completion', async () => {
    const { flows, complete } = harness();
    const started = flows.start('owner', connection, 'web', origin);
    const url = new URL(started.authorizationUrl);
    expect(started.redirectUri).toBe(`${origin}/app/mcp/oauth/callback`);
    expect(url.searchParams.get('scope')).toBe('read,write');
    expect(url.searchParams.get('state')).toBe(started.state);
    await flows.finish('owner', connection, { state: started.state, code: 'code' }, origin);
    const input = complete.mock.calls[0] as unknown as [
      EventStore,
      HttpMcpConnectionRecord,
      { codeVerifier: string; redirectUri: string },
    ];
    expect(createHash('sha256').update(input[2].codeVerifier).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(input[2].redirectUri).toBe(started.redirectUri);
    expect(JSON.stringify(started)).not.toContain(input[2].codeVerifier);
    await expect(
      flows.finish('owner', connection, { state: started.state, code: 'again' }, origin),
    ).rejects.toThrow(/missing/u);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('keeps a native callback independent of a private server address', () => {
    const { flows } = harness();
    expect(flows.start('owner', connection, 'native', 'http://192.168.0.8').redirectUri).toBe(
      'https://verity.build/mcp/oauth/callback',
    );
    expect(flows.start('owner', connection, 'native-staging', origin).state).toMatch(/^staging\./u);
  });
  it.each(['owner', 'connection', 'origin', 'config', 'expiry', 'cancel'] as const)(
    'rejects changed %s without exchanging a code',
    async (change) => {
      const { flows, complete, expire } = harness();
      const flow = flows.start('owner', connection, 'web', origin);
      if (change === 'expiry') expire();
      if (change === 'cancel') flows.cancel('owner', connection.id, flow.state);
      await expect(
        flows.finish(
          change === 'owner' ? 'other' : 'owner',
          {
            ...connection,
            ...(change === 'connection' ? { id: 'other' } : {}),
            ...(change === 'config' ? { oauthClientId: 'other' } : {}),
          },
          { state: flow.state, code: 'code' },
          change === 'origin' ? 'https://other.example' : origin,
        ),
      ).rejects.toThrow();
      expect(complete).not.toHaveBeenCalled();
    },
  );
  it('does not let foreign cancellation destroy an active flow', async () => {
    const { flows, complete } = harness();
    const flow = flows.start('owner', connection, 'web', origin);
    flows.cancel('other', connection.id, flow.state);
    await flows.finish('owner', connection, { state: flow.state, code: 'code' }, origin);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('invalidates a predecessor when a connection is reconnected', async () => {
    const { flows } = harness();
    const first = flows.start('owner', connection, 'web', origin);
    flows.start('owner', connection, 'web', origin);
    await expect(
      flows.finish('owner', connection, { state: first.state, code: 'code' }, origin),
    ).rejects.toThrow();
  });
  it.each([
    'http://192.168.0.8',
    'https://host.example/path',
    'https://user:pass@host.example',
    'https://host.example/#fragment',
  ])('rejects an untrusted web origin %s', (value) => {
    expect(() => mcpWebCallback(value)).toThrow();
  });
  it('permits localhost development', () => {
    expect(mcpWebCallback('http://localhost:8080')).toBe(
      'http://localhost:8080/app/mcp/oauth/callback',
    );
  });
});
