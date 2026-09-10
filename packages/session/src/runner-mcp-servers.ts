import type { HttpMcpServerDescriptor } from './backend-contract.js';

export function resolveRunnerMcpServers(input: {
  servers?: readonly HttpMcpServerDescriptor[];
  proxyToken?: string;
  gatewayUrl?: string;
}): readonly HttpMcpServerDescriptor[] | undefined {
  const usesInternalProxy = input.servers?.some(
    (server) => server.url === 'verity-internal://mcp-proxy',
  );
  if (usesInternalProxy === true && (input.gatewayUrl === undefined || input.gatewayUrl === '')) {
    throw new Error('the internal MCP proxy has no gateway URL');
  }
  if (usesInternalProxy === true && input.proxyToken === undefined) {
    throw new Error('the internal MCP proxy has no per-turn bearer');
  }
  if (usesInternalProxy !== true && input.proxyToken !== undefined) {
    throw new Error('the MCP proxy bearer has no internal proxy descriptor');
  }
  return input.servers?.map((server) => {
    if (server.url !== 'verity-internal://mcp-proxy') return server;
    const binding = server.headers.filter(
      (header) => header.name.toLowerCase() === 'x-verity-mcp-binding',
    );
    if (binding.length !== 1 || input.proxyToken === undefined || input.gatewayUrl === undefined) {
      throw new Error('the internal MCP proxy requires exactly one binding header');
    }
    return {
      name: server.name,
      url: new URL('/internal/mcp-proxy', input.gatewayUrl).toString(),
      headers: [binding[0]!, { name: 'Authorization', value: `Bearer ${input.proxyToken}` }],
    };
  });
}
