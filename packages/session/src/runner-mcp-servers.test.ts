import { describe, expect, it } from 'vitest';
import { resolveRunnerMcpServers } from './runner-mcp-servers.js';

const internal = (headers: { name: string; value: string }[]) => ({
  name: 'gmail',
  url: 'verity-internal://mcp-proxy',
  headers,
});

describe('runner MCP proxy boundary', () => {
  it('strips untrusted headers and injects only the turn bearer', () => {
    expect(
      resolveRunnerMcpServers({
        servers: [
          internal([
            { name: 'X-Verity-MCP-Binding', value: 'gmail-id' },
            { name: 'Authorization', value: 'attacker' },
          ]),
        ],
        proxyToken: 'turn-token',
        gatewayUrl: 'http://relay:8080/internal/mcp',
      }),
    ).toEqual([
      {
        name: 'gmail',
        url: 'http://relay:8080/internal/mcp-proxy',
        headers: [
          { name: 'X-Verity-MCP-Binding', value: 'gmail-id' },
          { name: 'Authorization', value: 'Bearer turn-token' },
        ],
      },
    ]);
  });

  it('rejects duplicate or missing bindings and mismatched tokens', () => {
    expect(() =>
      resolveRunnerMcpServers({
        servers: [internal([])],
        proxyToken: 'token',
        gatewayUrl: 'http://relay:8080/internal/mcp',
      }),
    ).toThrow(/exactly one binding/u);
    expect(() => resolveRunnerMcpServers({ proxyToken: 'orphan' })).toThrow(/no internal/u);
  });
});
