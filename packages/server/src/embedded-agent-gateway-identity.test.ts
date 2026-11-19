import { describe, expect, it, vi } from 'vitest';
import type { AgentGatewayConfiguration } from './agent-gateway-control.js';
import {
  createEmbeddedAgentGatewayBindingCallbacks,
  createEmbeddedAgentGatewayIdentityProjection,
} from './embedded-agent-gateway-identity.js';

type Context = Parameters<typeof createEmbeddedAgentGatewayBindingCallbacks>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const binding = (fingerprint256: string) => ({ projectId: 'project', fingerprint256 });
const tls = { ca: 'ca', cert: 'cert', key: 'key' };
function fixture() {
  const state: Context['state'] = {
    tls,
    bindings: [],
    bindingGeneration: 0,
    bindingProjection: Promise.resolve(),
    accessToken: 'token',
    codexAuthJson: undefined,
    openCode: undefined,
    people: [],
    personalClaudeTokens: new Map(),
  };
  const updateAndWait = vi
    .fn<(configuration: AgentGatewayConfiguration) => Promise<void>>()
    .mockResolvedValue(undefined);
  const routedAgentGatewayBindings = vi
    .fn<Context['routedAgentGatewayBindings']>()
    .mockImplementation(async (bindings) => bindings);
  const context: Context = {
    state,
    agentGatewayConfiguration: () => ({
      revision: 'test',
      claude: { tls, peerBindings: state.bindings },
    }),
    agentGatewaySynchronizer: {
      update: vi.fn(),
      updateAndWait,
      close: vi.fn(async () => undefined),
    },
    syncAgentGateway: vi.fn(),
    routedAgentGatewayBindings,
  };
  const gatewayMaterial = vi.fn(async () => ({ tls, peerBindings: [binding('current')] }));
  const refreshAgentGatewayCredential = vi.fn(async () => undefined);
  const project = () =>
    createEmbeddedAgentGatewayIdentityProjection({
      ...context,
      claudeEgressIdentity: { gatewayMaterial },
      refreshAgentGatewayCredential,
    });
  return {
    context,
    state,
    updateAndWait,
    routedAgentGatewayBindings,
    gatewayMaterial,
    refreshAgentGatewayCredential,
    project,
  };
}

describe('embedded Agent Gateway identity projection', () => {
  it('withdraws revoked bindings synchronously and confirms denial before authorizing new bindings', async () => {
    const instance = fixture();
    instance.state.bindings = [binding('retained'), binding('revoked')];
    const acknowledgement = deferred<void>();
    instance.updateAndWait.mockReturnValueOnce(acknowledgement.promise);
    const callbacks = createEmbeddedAgentGatewayBindingCallbacks(instance.context);
    const changed = callbacks.onBindingsChanged!([binding('retained'), binding('new')]);
    expect(instance.state.bindings).toEqual([binding('retained')]);
    expect(instance.updateAndWait).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        claude: expect.objectContaining({ peerBindings: [binding('retained')] }),
      }),
    );
    expect(instance.routedAgentGatewayBindings).not.toHaveBeenCalled();
    acknowledgement.resolve();
    await changed;
    expect(instance.state.bindings).toEqual([binding('retained'), binding('new')]);
    expect(instance.context.syncAgentGateway).toHaveBeenCalledOnce();
  });

  it('prevents a delayed binding inspection from restoring a subsequently revoked certificate', async () => {
    const instance = fixture();
    const first = deferred<readonly ReturnType<typeof binding>[]>();
    instance.routedAgentGatewayBindings.mockReturnValueOnce(first.promise);
    const callbacks = createEmbeddedAgentGatewayBindingCallbacks(instance.context);
    const oldProjection = callbacks.onBindingsChanged!([binding('old')]);
    await vi.waitFor(() => expect(instance.routedAgentGatewayBindings).toHaveBeenCalledOnce());
    await callbacks.onBindingsChanged!([binding('new')]);
    first.resolve([binding('old')]);
    await oldProjection;
    expect(instance.state.bindings).toEqual([binding('new')]);
    expect(instance.context.syncAgentGateway).toHaveBeenCalledOnce();
  });

  it('retries stale identity material before confirming a boot or unlock projection', async () => {
    const instance = fixture();
    const first = deferred<Awaited<ReturnType<typeof instance.gatewayMaterial>>>();
    instance.gatewayMaterial.mockReturnValueOnce(first.promise);
    const projection = instance.project()(true);
    instance.state.bindingGeneration += 1;
    first.resolve({ tls, peerBindings: [binding('stale')] });
    await projection;
    expect(instance.gatewayMaterial).toHaveBeenCalledTimes(2);
    expect(instance.state.bindings).toEqual([binding('current')]);
    expect(instance.updateAndWait).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        claude: expect.objectContaining({ peerBindings: [binding('current')] }),
      }),
    );
    expect(instance.context.syncAgentGateway).not.toHaveBeenCalled();
  });

  it('resolves pending credentials on demand and preserves sealed recovery spill', async () => {
    const instance = fixture();
    instance.state.accessToken = undefined;
    const project = instance.project();
    await project();
    expect(instance.refreshAgentGatewayCredential).toHaveBeenCalledOnce();
    expect(instance.context.syncAgentGateway).not.toHaveBeenCalled();
    instance.state.codexAuthJson = null;
    await project();
    expect(instance.context.syncAgentGateway).toHaveBeenCalledOnce();
    expect(instance.state.accessToken).toBeUndefined();
    const dormant = createEmbeddedAgentGatewayIdentityProjection({
      ...instance.context,
      claudeEgressIdentity: undefined,
      refreshAgentGatewayCredential: instance.refreshAgentGatewayCredential,
    });
    await dormant();
    expect(instance.refreshAgentGatewayCredential).toHaveBeenCalledTimes(2);
  });
});
