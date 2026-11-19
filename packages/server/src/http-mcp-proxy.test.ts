import { describe, expect, it } from 'vitest';

import {
  isForbiddenHttpMcpAddress,
  isHttpMcpEventStream,
  isRefusedMcpUpstreamAddress,
  parseHttpMcpUpstream,
  refusedMcpUpstreamRange,
} from './http-mcp-proxy.js';

describe('HTTP MCP proxy upstream validation', () => {
  it('recognizes event-stream media types case-insensitively', () => {
    expect(isHttpMcpEventStream('Text/Event-Stream; charset=utf-8')).toBe(true);
    expect(isHttpMcpEventStream('application/json')).toBe(false);
    expect(isHttpMcpEventStream('text/event-streaming')).toBe(false);
  });

  it('accepts a canonical public HTTPS endpoint', () => {
    expect(parseHttpMcpUpstream('https://mcp.example.com/gmail?account=work').toString()).toBe(
      'https://mcp.example.com/gmail?account=work',
    );
  });

  it.each([
    ['https://mcp.example.com:8443/gmail', 'https://mcp.example.com:8443/gmail'],
    ['https://100.102.249.21/mcp/privat', 'https://100.102.249.21/mcp/privat'],
    ['https://10.0.0.5:9443/mcp', 'https://10.0.0.5:9443/mcp'],
    ['https://[fd7a:115c:a1e0::1]/mcp', 'https://[fd7a:115c:a1e0::1]/mcp'],
  ])('accepts a port or a tailnet/private IP literal: %s', (url, expected) => {
    expect(parseHttpMcpUpstream(url).toString()).toBe(expected);
  });

  it.each([
    'http://mcp.example.com/gmail',
    'https://127.0.0.1/gmail',
    'https://127.0.0.1:8443/gmail',
    'https://[::1]/gmail',
    'https://[::ffff:127.0.0.1]/gmail',
    'https://169.254.169.254/latest',
    'https://0.0.0.0/gmail',
    'https://user:password@mcp.example.com/gmail',
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
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
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

describe('MCP upstream address ranges', () => {
  // Self-hosted MCP servers live here; refusing them broke tailnet servers such
  // as heey-docs while the sandbox-egress check below still refuses them.
  it.each([
    '8.8.8.8',
    '2606:4700:4700::1111',
    '100.64.0.1',
    '100.102.249.21',
    '100.127.255.254',
    'fd7a:115c:a1e0::1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    'fd00::1',
    '::ffff:100.102.249.21',
    '::ffff:192.168.0.1',
  ])('allows %s', (address) => {
    expect(isRefusedMcpUpstreamAddress(address)).toBe(false);
  });

  // These reach the Verity host or its cloud metadata, or hide an address
  // behind a translation prefix, whatever name resolves to them.
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.10.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['169.254.169.254', 'linkLocal'],
    ['::ffff:169.254.169.254', 'linkLocal'],
    ['fe80::1', 'linkLocal'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['ff02::1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['64:ff9b::7f00:1', 'rfc6052'],
    ['2002:7f00:1::', '6to4'],
    ['2001::1', 'teredo'],
    ['::7f00:1', 'ipv4Compatible'],
    ['::a9fe:a9fe', 'ipv4Compatible'],
    ['100.100.100.100', 'tailscaleService'],
    ['fd7a:115c:a1e0::53', 'tailscaleService'],
    ['100.100.100.200', 'cloudMetadata'],
    ['fd00:ec2::254', 'cloudMetadata'],
    ['::ffff:100.100.100.200', 'cloudMetadata'],
    ['not-an-address', 'invalid'],
  ])('refuses %s as %s', (address, range) => {
    expect(refusedMcpUpstreamRange(address)).toBe(range);
  });
});
