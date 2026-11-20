import { existsSync, readdirSync } from 'node:fs';
import { SealedError } from '@verity/store';
import { createPersonalProviderCredentials } from './personal-provider-credentials.js';
import { sandboxPersonTag } from './sandbox-identity.js';
import {
  materializeOpenCodeSettings,
  materializePersonalOpenCodeSettings,
  personalOpenCodeSubdir,
} from './provisioner.js';
import { startClaudeCredentialSync } from './embedded-support.js';
import { readCodexAccessToken } from './agent-gateway-control.js';
import type { CodexUsageCredentialProvider } from './codexUsage.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { ServerDeps } from './server-deps.js';

type PersonalCredentials = ReturnType<typeof createPersonalProviderCredentials>;
type ClaudeSync = ReturnType<typeof startClaudeCredentialSync>;

/** Project changed personal OpenCode logins into their existing directory mounts. */
export function createEmbeddedPersonalProviderCredentials({
  store,
  secretRoot,
  config,
}: {
  store: Parameters<typeof createPersonalProviderCredentials>[0]['store'];
  secretRoot: string;
  config: Pick<EmbeddedServerConfig, 'claudeConnectorPort'>;
}): PersonalCredentials {
  const personalProviderCredentials = createPersonalProviderCredentials({
    store,
    onError: (error) => {
      if (error instanceof SealedError) return;
      // Never include credential contents in this diagnostic.
      console.warn(`verity: a personal provider login could not be refreshed: ${String(error)}`);
    },
  });
  // A person's sandbox reads its OpenCode models from its own file; rewrite every
  // person's file when anyone's logins change, so a connected, changed or removed
  // provider reaches their running sandbox (the directory bind sees the swap).
  personalProviderCredentials.onChanged(() => {
    void (async () => {
      const connections = await store.userProviderConnections.listByProvider('opencode');
      const written = new Set<string>();
      for (const connection of connections) {
        const tag = sandboxPersonTag(connection.userId);
        materializePersonalOpenCodeSettings(
          connection,
          secretRoot,
          tag,
          config.claudeConnectorPort,
        );
        written.add(personalOpenCodeSubdir(tag));
      }
      const prefix = personalOpenCodeSubdir('');
      for (const entry of existsSync(secretRoot) ? readdirSync(secretRoot) : []) {
        if (entry.startsWith(prefix) && !written.has(entry))
          materializePersonalOpenCodeSettings(
            undefined,
            secretRoot,
            entry.slice(prefix.length),
            config.claudeConnectorPort,
          );
      }
    })().catch((error: unknown) => {
      if (error instanceof SealedError) return;
      console.warn(`verity: personal OpenCode configuration not refreshed: ${String(error)}`);
    });
  });
  return personalProviderCredentials;
}

/** Start the shared Claude refresh queue at its original bootstrap point. */
export function createEmbeddedClaudeCredentialSync(
  store: Parameters<typeof startClaudeCredentialSync>[0],
  secretRoot: string,
): ClaudeSync {
  return startClaudeCredentialSync(store, secretRoot, (error) => {
    if (error instanceof SealedError) return;
    // Never include credential contents in this diagnostic.
    console.warn(`verity: failed to synchronize rotated Claude credentials: ${String(error)}`);
  });
}

type CredentialBindings = Pick<
  ServerDeps,
  | 'onOpenCodeSettingsChanged'
  | 'persistAgentCredentials'
  | 'claudeOAuthTokenProvider'
  | 'personalClaudeAccessToken'
  | 'persistPersonalProviderCredentials'
  | 'codexGatewayCredentialProvider'
  | 'codexGatewayCredentialFor'
>;

/** Bind settings writes and usage probes to the existing credential refresh authorities. */
export function createEmbeddedProviderCredentialBindings({
  secretRoot,
  config,
  claudeCredentialSync,
  personalProviderCredentials,
  refreshAgentGatewayCredential,
  codexModelCatalog,
  codexGatewayCredentialProvider,
  codexGatewayControlSocket,
}: {
  secretRoot: string;
  config: Pick<EmbeddedServerConfig, 'claudeConnectorPort'>;
  claudeCredentialSync: Pick<ClaudeSync, 'persistCredentials' | 'getAccessToken'>;
  personalProviderCredentials: Pick<PersonalCredentials, 'claudeAccessToken' | 'persist'>;
  refreshAgentGatewayCredential: () => Promise<void>;
  codexModelCatalog: { refresh: () => Promise<void> } | undefined;
  codexGatewayCredentialProvider: CodexUsageCredentialProvider | undefined;
  codexGatewayControlSocket: string | undefined;
}): CredentialBindings {
  return {
    onOpenCodeSettingsChanged: async (settings) => {
      materializeOpenCodeSettings(settings, secretRoot, config.claudeConnectorPort);
      await refreshAgentGatewayCredential();
    },
    persistAgentCredentials: async (patch, persist) => {
      await claudeCredentialSync.persistCredentials(patch, persist);
      if (patch.codexAuthJson !== undefined) await codexModelCatalog?.refresh();
    },
    claudeOAuthTokenProvider: claudeCredentialSync.getAccessToken,
    personalClaudeAccessToken: (userId: string) =>
      personalProviderCredentials.claudeAccessToken(userId),
    persistPersonalProviderCredentials: (userId, provider, write) =>
      personalProviderCredentials.persist(userId, provider, write),
    // The Codex quota probe reads its token from the gateway, the single refresh
    // authority for the rotating Codex login (ADR 0010) — deliberately not from the
    // stored `codexAuthJson`, which would make the Server a second writer. Without a
    // gateway the probe stays inert and the meter keeps its per-session signal.
    ...(codexGatewayCredentialProvider === undefined ? {} : { codexGatewayCredentialProvider }),
    ...(codexGatewayControlSocket === undefined
      ? {}
      : {
          codexGatewayCredentialFor:
            (userId: string): CodexUsageCredentialProvider =>
            () =>
              readCodexAccessToken(codexGatewayControlSocket, userId),
        }),
  };
}
