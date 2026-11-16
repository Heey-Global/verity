import { administratorProviderConnections } from './administrator-provider-connections.js';
import type { FastifyInstance } from 'fastify';
import { SealedError, type ProviderConnectionKind, type VeritySettingsPatch } from '@verity/store';
import { createProcessAgentLoginService } from './agent-login.js';
import {
  createClaudeOAuthTokenProvider,
  createClaudeUsageService,
  type ClaudeOAuthTokenProvider,
} from './claudeUsage.js';
import { createCodexUsageService } from './codexUsage.js';
import type { ServerContext } from './server-context.js';
import { hasVeritySettingsStore, veritySettingsStore } from './server-support.js';

/** Own the server login service and credential persistence boundaries. */
export function createServerAgentCredentials(ctx: ServerContext) {
  const { deps, lifecycle } = ctx;
  const storeAgentCredentials = async (patch: VeritySettingsPatch): Promise<void> => {
    const persist = async (): Promise<void> => {
      if (deps.secretCipher?.isSealed() === true) throw new SealedError();
      await veritySettingsStore(deps.eventStore).updateVeritySettings(patch);
    };
    if (deps.persistAgentCredentials !== undefined) {
      await deps.persistAgentCredentials(patch, persist);
    } else {
      await persist();
    }
  };
  const administratorAccounts = administratorProviderConnections(
    deps.eventStore,
    storeAgentCredentials,
  );
  const persistPersonal = (
    userId: string,
    provider: ProviderConnectionKind,
    write: () => Promise<void>,
  ): Promise<void> => deps.persistPersonalProviderCredentials?.(userId, provider, write) ?? write();
  const agentLogin =
    deps.agentLogin ??
    createProcessAgentLoginService({
      updateSettings: storeAgentCredentials,
      storePersonal: async (userId, provider, credential) => {
        if (deps.secretCipher?.isSealed() === true) throw new SealedError();
        await persistPersonal(userId, provider, () =>
          administratorAccounts.owns(userId)
            ? administratorAccounts.set(provider, { credential })
            : deps.eventStore.userProviderConnections.set(userId, provider, { credential }),
        );
      },
    });
  lifecycle.onClose(() => {
    agentLogin.close();
  });
  return { storeAgentCredentials, persistPersonal, agentLogin, administratorAccounts };
}

/** Create usage probes at their original point in server initialization. */
export function createServerUsage(
  app: FastifyInstance,
  ctx: ServerContext,
  storeAgentCredentials: (patch: VeritySettingsPatch) => Promise<void>,
) {
  const { deps } = ctx;
  const dbClaudeOAuthTokenProvider: ClaudeOAuthTokenProvider = hasVeritySettingsStore(
    deps.eventStore,
  )
    ? createClaudeOAuthTokenProvider({
        env: {},
        credentialsPath: '/dev/null',
        credentialsJsonProvider: async () => {
          const credentialsJson = (await deps.eventStore.getVeritySettings())
            ?.claudeCodeOauthCredentialsJson;
          return typeof credentialsJson === 'string' && credentialsJson.trim().length > 0
            ? credentialsJson
            : undefined;
        },
        credentialsJsonUpdater: async (credentialsJson) => {
          await storeAgentCredentials({ claudeCodeOauthCredentialsJson: credentialsJson });
        },
      })
    : () => Promise.resolve(undefined);
  const defaultClaudeOAuthTokenProvider = async (): Promise<string | undefined> => {
    try {
      return await dbClaudeOAuthTokenProvider();
    } catch {
      // Sealed or temporarily unavailable settings make the usage probe inert
      // until a later poll can read the DB settings again. Do not fall back to
      // process env / ~/.claude here: the server-side meter should reflect the
      // centrally stored Verity login, not stale runtime state.
      return undefined;
    }
  };
  const claudeUsage =
    deps.claudeUsage ??
    createClaudeUsageService({
      log: app.log,
      tokenProvider: deps.claudeOAuthTokenProvider ?? defaultClaudeOAuthTokenProvider,
    });
  const codexUsage =
    deps.codexUsage ??
    createCodexUsageService({
      log: app.log,
      credentialProvider: deps.codexGatewayCredentialProvider,
    });
  return { dbClaudeOAuthTokenProvider, claudeUsage, codexUsage };
}
