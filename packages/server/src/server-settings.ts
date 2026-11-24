import type { FastifyInstance } from 'fastify';
import type { VeritySettingsPatch } from '@verity/store';
import { z } from 'zod';
import type { SecretStatus } from './attention.js';
import type { ClaudeOAuthTokenProvider } from './claudeUsage.js';
import type { ServerContext } from './server-context.js';
import type { ModelList } from './server-types.js';
import { registerConnectionUsageRoutes } from './connection-usage-routes.js';
import { registerDopplerRoutes } from './doppler-routes.js';
import { registerForgeConnectionRoutes } from './forge-connection-routes.js';
import { registerGitHubAppRoutes } from './github-app-routes.js';
import { registerGitHubManifestRoutes } from './github-manifest-routes.js';
import { registerGmailRoutes } from './gmail-routes.js';
import { googleAccountSettingsStatus } from './google-account-presentation.js';
import { googleAppClient } from './google-app-client.js';
import { registerGoogleCalendarRoutes } from './google-calendar-routes.js';
import { registerGoogleConnectRoutes } from './google-connect-routes.js';
import { registerGoogleContactsRoutes } from './google-contacts-routes.js';
import { registerGoogleDriveRoutes } from './google-drive-routes.js';
import { repositoryCatalog } from './project-collection-routes.js';
import { registerProjectGoogleRoutes } from './project-google-routes.js';
import { registerSecretLifecycleRoutes } from './secret-lifecycle-routes.js';
import { viewerId } from './view-state-routes.js';
import { registerSettingsRoutes, SELECTABLE_TRANSCRIBE_BACKEND_MODES } from './settings-routes.js';
import { registerSigningKeyRoutes } from './signing-key-routes.js';
import {
  veritySettingsStore,
  externalMeetingTranscriptionConfigured,
  effectiveExternalTranscription,
  publicVeritySettings,
} from './server-support.js';

type SecretLifecycleOptions = Parameters<typeof registerSecretLifecycleRoutes>[1];

const veritySettingsBody = z.object({
  advancedModeEnabled: z.boolean().optional(),
  unassignedMeetingRetentionDays: z.number().int().min(1).max(365).nullable().optional(),
  gitUserName: z.string().nullable().optional(),
  gitUserEmail: z.string().nullable().optional(),
  gitSshPrivateKeyPath: z.string().nullable().optional(),
  gitSshPrivateKey: z.string().nullable().optional(),
  gitSshPublicKeyPath: z.string().nullable().optional(),
  gitSshPublicKey: z.string().nullable().optional(),
  gitKnownHostsPath: z.string().nullable().optional(),
  gitKnownHosts: z.string().nullable().optional(),
  gitAllowedSignersPath: z.string().nullable().optional(),
  gitAllowedSigners: z.string().nullable().optional(),
  githubAppId: z.string().nullable().optional(),
  githubAppInstallationId: z.string().nullable().optional(),
  githubAppPrivateKey: z.string().nullable().optional(),
  dopplerServiceToken: z.string().nullable().optional(),
  transcribeBaseUrl: z.string().nullable().optional(),
  transcribeApiKey: z.string().nullable().optional(),
  transcribeModel: z.string().nullable().optional(),
  transcribeBackendMode: z.enum(SELECTABLE_TRANSCRIBE_BACKEND_MODES).nullable().optional(),
  claudeCodeOauthCredentialsJson: z.string().nullable().optional(),
  codexAuthJson: z.string().nullable().optional(),
  opencodeBaseUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      );
    }, 'OpenCode Base URL must be an HTTPS origin or path without credentials, query, or fragment')
    .nullable()
    .optional(),
  opencodeApiKey: z
    .string()
    .refine((value) => !/[\r\n]/u.test(value))
    .nullable()
    .optional(),
  opencodeDisabledModels: z.string().max(100_000).nullable().optional(),
  uplinkSubscriptionKey: z.string().trim().min(1).max(4096).nullable().optional(),
  premiumSharingEnabled: z.boolean().optional(),
  premiumRemoteAccessEnabled: z.boolean().optional(),
  projectEgressEnabled: z.boolean().optional(),
});

/** Closures `buildServer` still owns that the settings depend on. */
export interface SettingsWiring {
  storeAgentCredentials: (patch: VeritySettingsPatch) => Promise<void>;
  agentLogin: Parameters<typeof registerSettingsRoutes>[1]['agentLogin'];
  recoverQueuedTurns: SecretLifecycleOptions['recoverQueuedTurns'];
  dbClaudeOAuthTokenProvider: ClaudeOAuthTokenProvider;
  readSecretStatus: () => Promise<SecretStatus>;
  availableModels: () => Promise<ModelList>;
}

/**
 * Verity settings, the account and integration connections (Google, forges,
 * Doppler, GitHub App), the master-password secret store and signing keys.
 */
export function installSettings(
  app: FastifyInstance,
  ctx: ServerContext,
  {
    storeAgentCredentials,
    agentLogin,
    recoverQueuedTurns,
    dbClaudeOAuthTokenProvider,
    readSecretStatus,
    availableModels,
  }: SettingsWiring,
): void {
  const { deps } = ctx;
  const { refreshOpenCodeModels } = registerSettingsRoutes(app, {
    store: () => veritySettingsStore(deps.eventStore),
    agentLogin,
    onDopplerServiceTokenChanged: (token) =>
      deps.eventStore.dopplerConnections.setLegacyToken(token),
    parseSettingsPatch: (body) => veritySettingsBody.parse(body),
    projectEgressAvailable: deps.projectEgressAvailable,
    projectEgressStatus: deps.projectEgressStatus,
    storeAgentCredentials,
    publicSettings: async (settings, request) => ({
      ...publicVeritySettings(
        settings,
        googleAppClient(request, deps.googleDriveClientId, deps.stagingGoogleClientId) ??
          (request.headers['x-verity-app-variant'] === undefined ? undefined : null),
      ),
      ...(await googleAccountSettingsStatus(deps.eventStore, viewerId(request))),
      projectEgressAvailable: (await deps.projectEgressAvailable?.()) === true,
      ...(deps.projectEgressStatus
        ? { projectEgressStatus: await deps.projectEgressStatus() }
        : {}),
      claudeCredentialStatus: (
        deps.claudeOAuthTokenProvider ?? dbClaudeOAuthTokenProvider
      ).statusForCredentials?.(settings.claudeCodeOauthCredentialsJson) ?? {
        state: 'unknown',
        code: null,
      },
    }),
    effectiveTranscription: effectiveExternalTranscription,
    transcriptionConfigured: externalMeetingTranscriptionConfigured,
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.onUplinkCredentialsChanged !== undefined
      ? { onUplinkCredentialsChanged: deps.onUplinkCredentialsChanged }
      : {}),
    ...(deps.onPremiumFeatureSwitchesChanged !== undefined
      ? { onPremiumFeatureSwitchesChanged: deps.onPremiumFeatureSwitchesChanged }
      : {}),
    ...(deps.onOpenCodeSettingsChanged !== undefined
      ? { onOpenCodeSettingsChanged: deps.onOpenCodeSettingsChanged }
      : {}),
  });

  registerGoogleDriveRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.stagingGoogleClientId ? { stagingGoogleClientId: deps.stagingGoogleClientId } : {}),
    ...(deps.dataRoot !== undefined ? { dataRoot: deps.dataRoot } : {}),
    ...(deps.googleDriveClientId !== undefined
      ? { googleDriveClientId: deps.googleDriveClientId }
      : {}),
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.onGoogleCredentialsChanged !== undefined
      ? { onCredentialsChanged: deps.onGoogleCredentialsChanged }
      : {}),
  });
  registerGoogleConnectRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.stagingGoogleClientId ? { stagingGoogleClientId: deps.stagingGoogleClientId } : {}),
    ...(deps.googleDriveClientId !== undefined ? { googleClientId: deps.googleDriveClientId } : {}),
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.onGoogleCredentialsChanged !== undefined
      ? { onCredentialsChanged: deps.onGoogleCredentialsChanged }
      : {}),
  });
  registerForgeConnectionRoutes(
    app,
    deps.eventStore,
    async () => {
      const projects = deps.listAvailableRepositories
        ? await deps.listAvailableRepositories()
        : await deps.eventStore.listProjects({ includeHidden: true });
      return repositoryCatalog(projects).map((project) => ({
        owner: project.owner,
        repo: project.repo,
      }));
    },
    deps.forgejoEnabled === true,
  );
  registerConnectionUsageRoutes(app, deps.eventStore, () => availableModels());
  registerProjectGoogleRoutes(app, deps.eventStore);
  registerGmailRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.stagingGoogleClientId ? { stagingGoogleClientId: deps.stagingGoogleClientId } : {}),
    ...(deps.googleDriveClientId !== undefined ? { googleClientId: deps.googleDriveClientId } : {}),
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
  });
  registerGoogleCalendarRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.stagingGoogleClientId ? { stagingGoogleClientId: deps.stagingGoogleClientId } : {}),
    ...(deps.googleDriveClientId !== undefined ? { googleClientId: deps.googleDriveClientId } : {}),
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
  });
  registerGoogleContactsRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.stagingGoogleClientId ? { stagingGoogleClientId: deps.stagingGoogleClientId } : {}),
    ...(deps.googleDriveClientId !== undefined ? { googleClientId: deps.googleDriveClientId } : {}),
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
  });

  // ── Master-password secret-store lifecycle (ADR 0002 D3) ──────────────────
  // The cipher holds the at-rest key in memory only. `status` reports the
  // state; `init` sets the master password the first time; `unlock` re-derives
  // and verifies it after a restart (scrypt over the stored salt, checked
  // against the stored verifier before the key is trusted). A deployment
  // without a managed cipher reports 'unmanaged' and rejects init/unlock.
  registerSecretLifecycleRoutes(app, {
    browserRequestOrigin: deps.browserRequestOrigin,
    store: deps.eventStore,
    readStatus: readSecretStatus,
    recoverQueuedTurns,
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.devicePairing !== undefined ? { devicePairing: deps.devicePairing } : {}),
    ...(deps.authRegistry !== undefined ? { authRegistry: deps.authRegistry } : {}),
    ...(deps.unlockClientIdentity !== undefined
      ? { unlockClientIdentity: deps.unlockClientIdentity }
      : {}),
    onSecretUnlocked: async () => {
      await deps.onSecretUnlocked?.();
      await refreshOpenCodeModels();
    },
  });

  registerGitHubAppRoutes(app, {
    store: () => veritySettingsStore(deps.eventStore),
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.githubAppValidate !== undefined ? { validate: deps.githubAppValidate } : {}),
  });

  registerDopplerRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.dopplerWorkplace !== undefined ? { dopplerWorkplace: deps.dopplerWorkplace } : {}),
    ...(deps.dopplerCredentialReader !== undefined
      ? { dopplerCredentialReader: deps.dopplerCredentialReader }
      : {}),
    ...(deps.dopplerValidate !== undefined ? { dopplerValidate: deps.dopplerValidate } : {}),
    ...(deps.dopplerListProjects !== undefined
      ? { dopplerListProjects: deps.dopplerListProjects }
      : {}),
    ...(deps.dopplerListConfigs !== undefined
      ? { dopplerListConfigs: deps.dopplerListConfigs }
      : {}),
  });

  registerGitHubManifestRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.authRegistry !== undefined ? { authRegistry: deps.authRegistry } : {}),
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.manifestConvert !== undefined ? { manifestConvert: deps.manifestConvert } : {}),
    ...(deps.manifestStateNow !== undefined ? { manifestStateNow: deps.manifestStateNow } : {}),
  });

  registerSigningKeyRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.resolveGitHubAppIdentity !== undefined
      ? { resolveGitHubAppIdentity: deps.resolveGitHubAppIdentity }
      : {}),
    ...(deps.sshKeygen !== undefined ? { sshKeygen: deps.sshKeygen } : {}),
  });
}
