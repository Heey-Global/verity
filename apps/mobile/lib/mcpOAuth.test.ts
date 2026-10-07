import { isDemoMode } from './demoMode';
import * as AuthSession from 'expo-auth-session';
import type { HttpMcpConnection } from '@verity/mobile';
import { isOfficialGmailMcpUrl, runMcpOAuth } from './mcpOAuth';

describe('official Gmail MCP URL detection', () => {
  it('matches only the canonical Google endpoint', () => {
    expect(isOfficialGmailMcpUrl('https://gmailmcp.googleapis.com/mcp/v1')).toBe(true);
    expect(isOfficialGmailMcpUrl('https://evil.example/gmailmcp.googleapis.com/mcp/v1')).toBe(
      false,
    );
    expect(isOfficialGmailMcpUrl('https://gmailmcp.googleapis.com.evil.example/mcp/v1')).toBe(
      false,
    );
    expect(isOfficialGmailMcpUrl('http://gmailmcp.googleapis.com/mcp/v1')).toBe(false);
  });
});

jest.mock('./demoMode', () => ({ isDemoMode: jest.fn().mockReturnValue(false) }));
afterEach(() => jest.mocked(isDemoMode).mockReturnValue(false));

jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('expo-auth-session', () => ({ AuthRequest: jest.fn(), ResponseType: { Code: 'code' } }));

it('does not launch MCP OAuth in the local demo', async () => {
  jest.mocked(isDemoMode).mockReturnValue(true);
  const connection = {
    oauthClientId: 'client',
    oauthAuthorizationEndpoint: 'https://identity.example/authorize',
    oauthTokenEndpoint: 'https://identity.example/token',
    oauthScopes: 'read',
    url: 'https://service.example/mcp',
  } as HttpMcpConnection;
  await expect(runMcpOAuth(connection)).rejects.toThrow('Exit the demo');
  expect(AuthSession.AuthRequest).not.toHaveBeenCalled();
});
