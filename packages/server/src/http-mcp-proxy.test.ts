import { describe, expect, it } from 'vitest';

import { isForbiddenHttpMcpAddress, parseHttpMcpUpstream } from './http-mcp-proxy.js';

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

describe('HTTP MCP proxy address filtering', () => {
  it.each([
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '198.18.0.1',
    '192.0.0.8',
    '::1',
    'fd00::1',
    'fe80::1',
    '2001:db8::1',
    '2001::1',
    '2001:2::1',
  ])('rejects non-public address %s', (address) => {
    expect(isForbiddenHttpMcpAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isForbiddenHttpMcpAddress(address)).toBe(false);
    },
  );
});
