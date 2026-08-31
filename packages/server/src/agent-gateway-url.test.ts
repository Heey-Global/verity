import { describe, expect, it } from 'vitest';
import { parseAgentGatewayUrl, validateAgentGatewayRoutingConfig } from './agent-gateway-url.js';

describe('parseAgentGatewayUrl', () => {
  it('accepts a stable HTTPS origin on the listener port', () => {
    expect(parseAgentGatewayUrl('https://verity-agent-gateway:9443', 9443).href).toBe(
      'https://verity-agent-gateway:9443/',
    );
  });

  it.each([
    'http://verity-agent-gateway:9443',
    'https://user:secret@verity-agent-gateway:9443',
    'https://verity-agent-gateway:9443/provider',
    'https://verity-agent-gateway:9443/?mode=canary',
    'https://verity-agent-gateway:9443/#canary',
  ])('rejects a non-origin gateway URL: %s', (raw) => {
    expect(() => parseAgentGatewayUrl(raw)).toThrow(
      'Agent gateway URL must be an HTTPS origin without credentials or a path',
    );
  });

  it('rejects a URL whose port differs from the listener', () => {
    expect(() => parseAgentGatewayUrl('https://verity-agent-gateway:9444', 9443)).toThrow(
      'Agent gateway URL port must match the Claude listener port',
    );
  });

  it.each(['https://127.0.0.1:9443', 'https://[::1]:9443'])(
    'rejects an IP-literal host that cannot match a DNS SAN: %s',
    (raw) => {
      expect(() => parseAgentGatewayUrl(raw)).toThrow('Agent gateway URL must use a DNS hostname');
    },
  );
});

describe('validateAgentGatewayRoutingConfig', () => {
  const complete = {
    url: 'https://verity-agent-gateway:9443',
    controlSocket: '/run/verity-agent-gateway/control.sock',
    unsealKey: 'ephemeral-key',
    legacyGatewayUrl: 'https://verity:9443',
    connectorPort: 47_821,
    listenerPort: 9443,
  } as const;

  it('accepts a complete gateway configuration', () => {
    expect(validateAgentGatewayRoutingConfig(complete).url?.hostname).toBe('verity-agent-gateway');
  });

  it('stays dormant when no gateway is configured at all', () => {
    expect(validateAgentGatewayRoutingConfig({}).url).toBeUndefined();
  });

  it.each([
    'controlSocket',
    'unsealKey',
    'legacyGatewayUrl',
    'connectorPort',
    'listenerPort',
  ] as const)('fails closed when a named gateway omits %s', (key) => {
    expect(() => validateAgentGatewayRoutingConfig({ ...complete, [key]: undefined })).toThrow(
      'Agent gateway routing requires URL, control socket, unseal key, and Claude egress configuration',
    );
  });

  it('rejects a gateway URL on a different port from the listener', () => {
    expect(() => validateAgentGatewayRoutingConfig({ ...complete, listenerPort: 9444 })).toThrow(
      'Agent gateway URL port must match the Claude listener port',
    );
  });
});
