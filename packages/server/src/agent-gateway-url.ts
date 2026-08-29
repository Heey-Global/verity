import { isIP } from 'node:net';

export const AGENT_GATEWAY_SERVER_NAME = 'verity-agent-gateway';

export function parseAgentGatewayUrl(raw: string, expectedPort?: number): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Agent gateway URL must be an HTTPS origin without credentials or a path');
  }
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(hostname) !== 0) {
    throw new Error('Agent gateway URL must use a DNS hostname');
  }

  const effectivePort = url.port === '' ? 443 : Number(url.port);
  if (expectedPort !== undefined && effectivePort !== expectedPort) {
    throw new Error('Agent gateway URL port must match the Claude listener port');
  }
  return url;
}

/**
 * Every Claude project turn is routed through the Agent Gateway. There is no
 * per-project selection and no un-routed fallback, so a deployment that names a
 * gateway must carry the complete configuration behind it.
 */
export function validateAgentGatewayRoutingConfig(options: {
  url?: string | undefined;
  controlSocket?: string | undefined;
  unsealKey?: string | undefined;
  legacyGatewayUrl?: string | undefined;
  connectorPort?: number | undefined;
  listenerPort?: number | undefined;
}): { url: URL | undefined } {
  if (options.url === undefined) return { url: undefined };
  if (
    options.controlSocket === undefined ||
    options.unsealKey === undefined ||
    options.legacyGatewayUrl === undefined ||
    options.connectorPort === undefined ||
    options.listenerPort === undefined
  ) {
    throw new Error(
      'Agent gateway routing requires URL, control socket, unseal key, and Claude egress configuration',
    );
  }
  return { url: parseAgentGatewayUrl(options.url, options.listenerPort) };
}
