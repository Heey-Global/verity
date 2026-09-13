import { isOfficialGmailMcpUrl } from './mcpOAuth';

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
