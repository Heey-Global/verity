import { createHash } from 'node:crypto';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { ClaudeEgressMtlsMaterial, ClaudeEgressPeerBinding } from './claude-egress-mtls.js';
import {
  readCodexAccessToken,
  type AgentGatewayConfiguration,
  type AgentGatewayPerson,
} from './agent-gateway-control.js';
import {
  startAgentGatewaySynchronizer,
  type AgentGatewaySynchronizer,
} from './agent-gateway-sync.js';
import { validateAgentGatewayRoutingConfig } from './agent-gateway-url.js';
import type { CodexUsageCredentialProvider } from './codexUsage.js';
import type { startClaudeCredentialSync } from './embedded-support.js';
import type { createPersonalProviderCredentials } from './personal-provider-credentials.js';
import { legacyAdministratorId } from './view-state-routes.js';

interface AgentGatewayState {
  tls: ClaudeEgressMtlsMaterial | undefined;
  bindings: readonly ClaudeEgressPeerBinding[];
  bindingGeneration: number;
  bindingProjection: Promise<void>;
  /** Undefined keeps recovery spill; null explicitly revokes; a string installs a login. */
  accessToken: string | null | undefined;
  /** Undefined is unresolved; null revokes; a string installs a source login. */
  codexAuthJson: string | null | undefined;
  openCode: AgentGatewayConfiguration['opencode'];
  people: readonly AgentGatewayPerson[];
  personalClaudeTokens: Map<string, string>;
}

export function createEmbeddedAgentGateway({
  config,
  personalProviderCredentials,
  getClaudeCredentialSync,
  onError,
}: {
  config: Pick<
    EmbeddedServerConfig,
    | 'agentGatewayUrl'
    | 'agentGatewayControlSocket'
    | 'agentGatewayUnsealKey'
    | 'claudeEgressGatewayUrl'
    | 'claudeConnectorPort'
    | 'agentGatewayClaudePort'
  >;
  personalProviderCredentials: Pick<
    ReturnType<typeof createPersonalProviderCredentials>,
    'persistCodexUpdate'
  >;
  getClaudeCredentialSync: () => Pick<
    ReturnType<typeof startClaudeCredentialSync>,
    'getAccessToken' | 'persistCodexCredentialUpdate'
  >;
  onError: (error: unknown) => void;
}) {
  const state: AgentGatewayState = {
    tls: undefined,
    bindings: [],
    bindingGeneration: 0,
    bindingProjection: Promise.resolve(),
    accessToken: undefined,
    codexAuthJson: undefined,
    openCode: undefined,
    // Each person's own logins (ADR 0023 §3), projected beside the instance login.
    people: [],
    personalClaudeTokens: new Map(),
  };
  const { url: agentGatewayUrl } = validateAgentGatewayRoutingConfig({
    url: config.agentGatewayUrl,
    controlSocket: config.agentGatewayControlSocket,
    unsealKey: config.agentGatewayUnsealKey,
    legacyGatewayUrl: config.claudeEgressGatewayUrl,
    connectorPort: config.claudeConnectorPort,
    listenerPort: config.agentGatewayClaudePort,
  });
  const agentGatewaySynchronizer: AgentGatewaySynchronizer | undefined =
    config.agentGatewayControlSocket === undefined
      ? undefined
      : startAgentGatewaySynchronizer({
          socketPath: config.agentGatewayControlSocket,
          onError(error): void {
            onError(error);
          },
          persistCodexCredentialUpdate: (update) =>
            update.userId === undefined
              ? getClaudeCredentialSync().persistCodexCredentialUpdate(update)
              : personalProviderCredentials.persistCodexUpdate({
                  ...update,
                  userId: update.userId,
                }),
        });
  const codexGatewayControlSocket = config.agentGatewayControlSocket;
  // Passed straight through: `readCodexAccessToken` already throws a
  // `CodexSignInUnusableError` subclass when the gateway says the sign-in is what
  // failed, which is exactly the distinction the usage probe acts on. Anything
  // else it throws stays an ordinary failure, because signing in again would not
  // fix a socket that did not answer.
  const codexGatewayCredentialProvider: CodexUsageCredentialProvider | undefined =
    codexGatewayControlSocket === undefined
      ? undefined
      : () => readCodexAccessToken(codexGatewayControlSocket);
  const agentGatewayConfiguration = (): AgentGatewayConfiguration | undefined => {
    if (config.agentGatewayControlSocket === undefined || state.tls === undefined) {
      return undefined;
    }
    const { ca, cert, key } = state.tls;
    if (typeof ca !== 'string' || typeof cert !== 'string' || typeof key !== 'string') {
      throw new Error('Agent gateway requires PEM-string TLS material');
    }
    // Every project is routed, so every binding belongs on the gateway.
    const routedBindings = state.bindings;
    const revision = createHash('sha256')
      .update(cert)
      .update(
        state.accessToken === undefined
          ? '\0credential-pending'
          : state.accessToken === null
            ? '\0credential-revoked'
            : `\0credential:${state.accessToken}`,
      )
      .update(
        state.codexAuthJson === undefined
          ? '\0codex-pending'
          : state.codexAuthJson === null
            ? '\0codex-revoked'
            : `\0codex:${state.codexAuthJson}`,
      )
      .update(
        state.openCode === undefined
          ? '\0opencode-pending'
          : `\0opencode:${state.openCode.baseUrl}:${state.openCode.apiKey ?? '\0revoked'}`,
      )
      .update(
        routedBindings
          .map(
            (binding) => `${binding.projectId}:${binding.userId ?? ''}:${binding.fingerprint256}`,
          )
          .sort()
          .join('\n'),
      )
      .update(`\0personal:${JSON.stringify(state.people)}`)
      .digest('hex');
    return {
      revision,
      claude: {
        tls: { ca, cert, key },
        peerBindings: routedBindings,
        ...(config.agentGatewayUnsealKey === undefined
          ? {}
          : {
              credential: {
                unsealKey: config.agentGatewayUnsealKey,
                // An unresolved token must recover spill rather than revoke it
                // when another provider's credential update is projected.
                ...(state.accessToken === undefined ? {} : { accessToken: state.accessToken }),
              },
            }),
      },
      ...(config.agentGatewayUnsealKey === undefined || state.codexAuthJson === undefined
        ? {}
        : {
            codex: {
              credential: {
                unsealKey: config.agentGatewayUnsealKey,
                sourceRevision: createHash('sha256')
                  .update(state.codexAuthJson ?? '\0revoked')
                  .digest('hex'),
                authJson: state.codexAuthJson,
              },
            },
          }),
      ...(state.openCode === undefined ? {} : { opencode: state.openCode }),
      ...(config.agentGatewayUnsealKey === undefined
        ? {}
        : {
            personal: {
              // Every project's original sandbox is the administrator's, whose
              // login the instance login was.
              instanceUserId: legacyAdministratorId,
              unsealKey: config.agentGatewayUnsealKey,
              people: state.people,
            },
          }),
    };
  };
  const syncAgentGateway = (): void => {
    const configuration = agentGatewayConfiguration();
    if (configuration === undefined) return;
    agentGatewaySynchronizer?.update(configuration);
  };
  const synchronizeAgentGatewayForTurn = async (): Promise<void> => {
    if (config.agentGatewayControlSocket === undefined) {
      throw new Error('Agent Gateway control socket is not configured');
    }
    for (;;) {
      const bindingGeneration = state.bindingGeneration;
      await state.bindingProjection;
      // Identity/container work and token refreshes are asynchronous. Accept the
      // snapshot only if no issuance or revocation began while we waited.
      const accessToken = await getClaudeCredentialSync().getAccessToken();
      if (bindingGeneration !== state.bindingGeneration) continue;
      state.accessToken = accessToken ?? null;
      const configuration = agentGatewayConfiguration();
      if (configuration === undefined) {
        throw new Error('Agent Gateway identity material is unavailable');
      }
      if (agentGatewaySynchronizer === undefined) {
        throw new Error('Agent Gateway synchronizer is unavailable');
      }
      await agentGatewaySynchronizer.updateAndWait(configuration);
      return;
    }
  };
  return {
    state,
    agentGatewayUrl,
    agentGatewaySynchronizer,
    codexGatewayControlSocket,
    codexGatewayCredentialProvider,
    agentGatewayConfiguration,
    syncAgentGateway,
    synchronizeAgentGatewayForTurn,
  };
}
