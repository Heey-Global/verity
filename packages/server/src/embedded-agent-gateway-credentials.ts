import { SealedError, type EventStore } from '@verity/store';
import { ClaudeOAuthResolutionError } from './claudeUsage.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { createEmbeddedAgentGateway } from './embedded-agent-gateway.js';
import type { startClaudeCredentialSync } from './embedded-support.js';
import type { createPersonalProviderCredentials } from './personal-provider-credentials.js';

export function createEmbeddedAgentGatewayCredentials({
  config,
  eventStore,
  claudeCredentialSync,
  personalProviderCredentials,
  agentGatewayState,
  syncAgentGateway,
}: {
  config: Pick<EmbeddedServerConfig, 'agentGatewayControlSocket' | 'agentGatewayUnsealKey'>;
  eventStore: Pick<EventStore, 'getVeritySettings'>;
  claudeCredentialSync: Pick<
    ReturnType<typeof startClaudeCredentialSync>,
    'getAccessToken' | 'onCredentialsChanged'
  >;
  personalProviderCredentials: Pick<
    ReturnType<typeof createPersonalProviderCredentials>,
    'people' | 'onChanged'
  >;
  agentGatewayState: Pick<
    ReturnType<typeof createEmbeddedAgentGateway>['state'],
    'accessToken' | 'codexAuthJson' | 'openCode' | 'people' | 'personalClaudeTokens'
  >;
  syncAgentGateway: () => void;
}) {
  let stopAgentGatewayCredentialProjection = (): Promise<void> => Promise.resolve();
  // Resolve the Claude credential on demand. A sealed boot cannot read it, and
  // the identity projection has no configuration to send without it, so
  // whoever unlocks the store has to ask for it again rather than wait out the
  // 60s reconciler. Assigned only when credential projection is wired up at all.
  let refreshAgentGatewayCredential = (): Promise<void> => Promise.resolve();
  if (
    config.agentGatewayControlSocket !== undefined &&
    config.agentGatewayUnsealKey !== undefined
  ) {
    const projectCredential = async (): Promise<void> => {
      // Only a missing or unusable login revokes the credential. A transient
      // refresh failure must retain the last projection for the next retry.
      let projected = agentGatewayState.accessToken;
      let credentialError: Error | undefined;
      try {
        projected = (await claudeCredentialSync.getAccessToken()) ?? null;
      } catch (error) {
        if (error instanceof ClaudeOAuthResolutionError && error.state === 'relogin_required') {
          projected = null;
        } else {
          credentialError =
            error instanceof Error ? error : new Error('Claude credential resolution failed');
        }
      }
      const settings = await eventStore.getVeritySettings();
      const codexAuth = settings?.codexAuthJson;
      const projectedCodex =
        typeof codexAuth === 'string' && codexAuth.trim().length > 0 ? codexAuth : null;
      const openCodeBaseUrl = settings?.opencodeBaseUrl?.trim();
      const openCodeApiKey = settings?.opencodeApiKey?.trim();
      const projectedOpenCode =
        openCodeBaseUrl === undefined ||
        openCodeBaseUrl.length === 0 ||
        openCodeApiKey === undefined ||
        openCodeApiKey.length === 0
          ? undefined
          : { baseUrl: openCodeBaseUrl, apiKey: openCodeApiKey };
      const personal = await personalProviderCredentials.people(
        agentGatewayState.personalClaudeTokens,
      );
      if (
        projected !== agentGatewayState.accessToken ||
        projectedCodex !== agentGatewayState.codexAuthJson ||
        JSON.stringify(projectedOpenCode) !== JSON.stringify(agentGatewayState.openCode) ||
        JSON.stringify(personal.people) !== JSON.stringify(agentGatewayState.people)
      ) {
        agentGatewayState.accessToken = projected;
        agentGatewayState.codexAuthJson = projectedCodex;
        agentGatewayState.openCode = projectedOpenCode;
        agentGatewayState.people = personal.people;
        agentGatewayState.personalClaudeTokens = personal.claudeTokens;
        syncAgentGateway();
      }
      // Claude refresh must not hold another provider's logout hostage. Report
      // the failure only after projecting the independently readable settings.
      if (credentialError !== undefined) throw credentialError;
    };
    let projection: Promise<void> | undefined;
    let projectionRequested = false;
    let projectionClosed = false;
    const projectCredentialSafely = (): void => {
      if (projectionClosed) return;
      projectionRequested = true;
      if (projection !== undefined) return;
      projection = (async () => {
        while (!projectionClosed && projectionRequested) {
          projectionRequested = false;
          await projectCredential().catch((error) => {
            // Runs during control-plane construction, before `app` exists, so it
            // must not reference the Fastify logger (doing so threw a TDZ
            // ReferenceError that crash-looped the server on every sealed boot).
            // A sealed store is the expected boot state — stay quiet and let the
            // periodic reconciler retry once the store is unlocked.
            if (error instanceof SealedError) return;
            console.warn(`verity: agent gateway credential projection failed: ${String(error)}`);
          });
        }
      })().finally(() => {
        projection = undefined;
        if (!projectionClosed && projectionRequested) projectCredentialSafely();
      });
    };
    // Awaiting the in-flight cycle lets the unlock path establish the credential
    // before it returns, so a caller that unlocks and then inspects the gateway
    // sees a projected configuration rather than a race.
    refreshAgentGatewayCredential = async (): Promise<void> => {
      projectCredentialSafely();
      await projection;
    };
    projectCredentialSafely();
    const unsubscribe = claudeCredentialSync.onCredentialsChanged(projectCredentialSafely);
    const unsubscribePersonal = personalProviderCredentials.onChanged(projectCredentialSafely);
    const timer = setInterval(projectCredentialSafely, 60_000);
    timer.unref();
    stopAgentGatewayCredentialProjection = async (): Promise<void> => {
      clearInterval(timer);
      unsubscribe();
      unsubscribePersonal();
      projectionClosed = true;
      await projection;
    };
  }

  return { refreshAgentGatewayCredential, stopAgentGatewayCredentialProjection };
}
