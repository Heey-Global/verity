import type { createEmbeddedAgentGateway } from './embedded-agent-gateway.js';
import type {
  ClaudeEgressIdentityService,
  ClaudeEgressIdentityOptions,
} from './claude-egress-identity.js';
import type { ClaudeEgressPeerBinding } from './claude-egress-mtls.js';

type ProjectionContext = Pick<
  ReturnType<typeof createEmbeddedAgentGateway>,
  'state' | 'agentGatewayConfiguration' | 'agentGatewaySynchronizer' | 'syncAgentGateway'
> & {
  routedAgentGatewayBindings: (
    bindings: readonly ClaudeEgressPeerBinding[],
  ) => Promise<readonly ClaudeEgressPeerBinding[]>;
};

export function createEmbeddedAgentGatewayBindingCallbacks({
  state: agentGatewayState,
  agentGatewayConfiguration,
  agentGatewaySynchronizer,
  syncAgentGateway,
  routedAgentGatewayBindings,
}: ProjectionContext): Pick<
  ClaudeEgressIdentityOptions,
  'onBindingsChanged' | 'onGatewayLeafChanged'
> {
  return {
    async onBindingsChanged(bindings): Promise<void> {
      agentGatewayState.bindingGeneration += 1;
      const bindingGeneration = agentGatewayState.bindingGeneration;
      const currentFingerprints = new Set(
        bindings.map((binding) => `${binding.projectId}\0${binding.fingerprint256}`),
      );
      // Denials are synchronous and never depend on Docker: remove revoked
      // fingerprints from the projected cache before inspecting containers
      // to decide whether newly issued bindings may be authorized.
      agentGatewayState.bindings = agentGatewayState.bindings.filter((binding) =>
        currentFingerprints.has(`${binding.projectId}\0${binding.fingerprint256}`),
      );
      const denialConfiguration = agentGatewayConfiguration();
      if (denialConfiguration !== undefined && agentGatewaySynchronizer !== undefined) {
        await agentGatewaySynchronizer.updateAndWait(denialConfiguration);
      }
      if (bindingGeneration !== agentGatewayState.bindingGeneration) return;
      const projection = (async (): Promise<void> => {
        const routedBindings = await routedAgentGatewayBindings(bindings);
        if (bindingGeneration !== agentGatewayState.bindingGeneration) return;
        agentGatewayState.bindings = routedBindings;
        syncAgentGateway();
      })();
      agentGatewayState.bindingProjection = projection;
      await projection;
    },
    onGatewayLeafChanged(material): void {
      agentGatewayState.tls = material;
      syncAgentGateway();
    },
  };
}

export function createEmbeddedAgentGatewayIdentityProjection({
  state: agentGatewayState,
  agentGatewayConfiguration,
  agentGatewaySynchronizer,
  syncAgentGateway,
  routedAgentGatewayBindings,
  claudeEgressIdentity,
  refreshAgentGatewayCredential,
}: ProjectionContext & {
  claudeEgressIdentity: Pick<ClaudeEgressIdentityService, 'gatewayMaterial'> | undefined;
  refreshAgentGatewayCredential: () => Promise<void>;
}) {
  const projectAgentGatewayIdentity = async (confirm = false): Promise<void> => {
    if (claudeEgressIdentity === undefined) return;
    // A sealed boot cannot read the Claude credential, so it stays `undefined`
    // and the projection below sends nothing at all — the synchronizer has no
    // snapshot, and its reconciler is a no-op until the 60s credential timer.
    // That hole is wide enough for a self-update to replace the gateway with an
    // empty container and give up waiting for a health it cannot reach yet, so
    // resolve the credential here, before the generation-guarded loop. Once it
    // is resolved this is skipped, which keeps the per-container-start path free.
    if (agentGatewayState.accessToken === undefined) await refreshAgentGatewayCredential();
    for (;;) {
      const bindingGeneration = agentGatewayState.bindingGeneration;
      const material = await claudeEgressIdentity.gatewayMaterial();
      const routedBindings = await routedAgentGatewayBindings(material.peerBindings);
      // Issuance/revocation callbacks advance the generation before doing their
      // own asynchronous Docker inspection. Never let an older snapshot overtake
      // one of those mutations and re-authorize a revoked certificate.
      if (bindingGeneration !== agentGatewayState.bindingGeneration) continue;
      agentGatewayState.tls = material.tls;
      agentGatewayState.bindings = routedBindings;
      // A sealed store must not revoke recovery spill. Once another provider's
      // settings are readable, its updates may proceed with Claude in recovery
      // mode even while Claude's token resolution remains unavailable.
      if (
        agentGatewayState.accessToken !== undefined ||
        agentGatewayState.codexAuthJson !== undefined ||
        agentGatewayState.openCode !== undefined
      ) {
        const configuration = agentGatewayConfiguration();
        if (configuration !== undefined && agentGatewaySynchronizer !== undefined && confirm) {
          await agentGatewaySynchronizer.updateAndWait(configuration);
        } else {
          syncAgentGateway();
        }
      }
      return;
    }
  };
  return projectAgentGatewayIdentity;
}
