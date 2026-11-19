import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddedAgentGatewayCredentials } from './embedded-agent-gateway-credentials.js';

type Options = Parameters<typeof createEmbeddedAgentGatewayCredentials>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const credentialListeners = new Set<() => void>();
  const personalListeners = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) =>
    vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
  const getAccessToken = vi
    .fn<Options['claudeCredentialSync']['getAccessToken']>()
    .mockResolvedValue('fresh-token');
  const people = vi
    .fn<Options['personalProviderCredentials']['people']>()
    .mockResolvedValue({ people: [], claudeTokens: new Map() });
  const options: Options = {
    config: {
      agentGatewayControlSocket: '/unused/gateway.sock',
      agentGatewayUnsealKey: 'test-key',
    },
    eventStore: { getVeritySettings: vi.fn().mockResolvedValue(undefined) },
    claudeCredentialSync: { getAccessToken, onCredentialsChanged: subscribe(credentialListeners) },
    personalProviderCredentials: { people, onChanged: subscribe(personalListeners) },
    agentGatewayState: {
      accessToken: undefined,
      codexAuthJson: undefined,
      openCode: undefined,
      people: [],
      personalClaudeTokens: new Map(),
    },
    syncAgentGateway: vi.fn(),
  };
  const changed = () => {
    for (const listener of [...credentialListeners, ...personalListeners]) listener();
  };
  return { options, getAccessToken, people, changed, credentialListeners, personalListeners };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('embedded Agent Gateway credential projection', () => {
  it('stays dormant without both the control socket and unseal key', async () => {
    for (const config of [
      {},
      { agentGatewayControlSocket: '/unused/gateway.sock' },
      { agentGatewayUnsealKey: 'test-key' },
    ]) {
      const instance = fixture();
      instance.options.config = config;
      const projection = createEmbeddedAgentGatewayCredentials(instance.options);
      await projection.refreshAgentGatewayCredential();
      await projection.stopAgentGatewayCredentialProjection();
      expect(instance.getAccessToken).not.toHaveBeenCalled();
      expect(instance.credentialListeners.size).toBe(0);
      expect(instance.personalListeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('coalesces changes into a serialized follow-up cycle and waits for it on refresh', async () => {
    const instance = fixture();
    const first = deferred<string | undefined>();
    instance.getAccessToken.mockReturnValueOnce(first.promise);
    const projection = createEmbeddedAgentGatewayCredentials(instance.options);
    instance.changed();
    instance.changed();
    const refresh = projection.refreshAgentGatewayCredential();
    expect(instance.getAccessToken).toHaveBeenCalledOnce();
    first.resolve('older-token');
    await refresh;
    expect(instance.getAccessToken).toHaveBeenCalledTimes(2);
    expect(instance.options.agentGatewayState.accessToken).toBe('fresh-token');
    expect(instance.people).toHaveBeenCalledTimes(2);
    await projection.stopAgentGatewayCredentialProjection();
  });

  it('unsubscribes, stops retries and drains the in-flight projection before close returns', async () => {
    const instance = fixture();
    const first = deferred<string | undefined>();
    instance.getAccessToken.mockReturnValueOnce(first.promise);
    const projection = createEmbeddedAgentGatewayCredentials(instance.options);
    instance.changed();
    let stopped = false;
    const close = projection.stopAgentGatewayCredentialProjection().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(instance.credentialListeners.size).toBe(0);
    expect(instance.personalListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    first.resolve('last-token');
    await close;
    expect(instance.options.agentGatewayState.accessToken).toBe('last-token');
    instance.changed();
    await vi.advanceTimersByTimeAsync(60_000);
    await projection.refreshAgentGatewayCredential();
    expect(instance.getAccessToken).toHaveBeenCalledOnce();
    expect(stopped).toBe(true);
  });

  it('retains Claude on transient failure while independently projecting other-provider logout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const instance = fixture();
    instance.options.agentGatewayState.accessToken = 'retained-token';
    instance.options.agentGatewayState.codexAuthJson = 'old-codex-login';
    instance.options.agentGatewayState.openCode = {
      baseUrl: 'https://provider.test',
      apiKey: 'old-key',
    };
    instance.getAccessToken.mockRejectedValue(new Error('temporarily unavailable'));
    const projection = createEmbeddedAgentGatewayCredentials(instance.options);
    await projection.refreshAgentGatewayCredential();
    expect(instance.options.agentGatewayState.accessToken).toBe('retained-token');
    expect(instance.options.agentGatewayState.codexAuthJson).toBeNull();
    expect(instance.options.agentGatewayState.openCode).toBeUndefined();
    expect(instance.options.syncAgentGateway).toHaveBeenCalledOnce();
    await projection.stopAgentGatewayCredentialProjection();
  });
});
