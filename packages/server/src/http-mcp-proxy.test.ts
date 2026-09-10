import { describe, expect, it } from 'vitest';

import { parseHttpMcpUpstream } from './http-mcp-proxy.js';

describe('HTTP MCP proxy upstream validation', () => {
  it('accepts a canonical public HTTPS endpoint', () => {
    expect(parseHttpMcpUpstream('https://mcp.example.com/gmail?account=work').toString()).toBe(
      'https://mcp.example.com/gmail?account=work',
    );
  });

  it.each([
    'http://mcp.example.com/gmail',
    'https://127.0.0.1/gmail',
    'https://[::1]/gmail',
    'https://user:password@mcp.example.com/gmail',
    'https://mcp.example.com:8443/gmail',
    'https://mcp.example.com/gmail#secret',
  ])('rejects an unsafe upstream: %s', (url) => {
    expect(() => parseHttpMcpUpstream(url)).toThrow('invalid HTTP MCP upstream');
  });
});
