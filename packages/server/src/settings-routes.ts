import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  SealableSecretCipher,
  VeritySettingsPatch,
  VeritySettingsRecord,
} from '@verity/store';
import { SealedError } from '@verity/store';
import type { AgentLoginService } from './agent-login.js';
import { fetchOpenCodeModels } from './opencode-model-catalog.js';

interface SettingsRouteStore {
  getVeritySettingsRaw(): Promise<VeritySettingsRecord | undefined>;
  getVeritySettings(): Promise<VeritySettingsRecord | undefined>;
  updateVeritySettings(patch: VeritySettingsPatch): Promise<VeritySettingsRecord>;
  updateTranscribeBackendMode(mode: 'external'): Promise<void>;
}

export interface SettingsRouteDeps {
  store: () => SettingsRouteStore;
  agentLogin: AgentLoginService;
  secretCipher?: SealableSecretCipher | undefined;
  parseSettingsPatch: (body: unknown) => VeritySettingsPatch;
  storeAgentCredentials: (patch: VeritySettingsPatch) => Promise<void>;
  publicSettings: (settings: VeritySettingsRecord) => unknown;
  effectiveTranscription: (settings: VeritySettingsRecord | null) => {
    baseUrl: string | null;
    model: string | null;
    apiKeyConfigured: boolean;
  };
  transcriptionConfigured: (settings: VeritySettingsRecord | null) => boolean;
  onUplinkCredentialsChanged?: (() => void) | undefined;
  onOpenCodeSettingsChanged?:
    ((settings: VeritySettingsRecord) => void | Promise<void>) | undefined;
}

export const SELECTABLE_TRANSCRIBE_BACKEND_MODES = ['external'] as const;

const transcriptionBackendBody = z.object({ mode: z.enum(SELECTABLE_TRANSCRIBE_BACKEND_MODES) });
const agentLoginProviderParam = z.object({ provider: z.enum(['claude', 'codex']) });
const agentLoginSessionParam = z.object({ sessionId: z.string().uuid() });
const agentLoginCodeBody = z.object({ code: z.string().trim().min(1).max(20_000) });

/** Public settings, transcription selection, and interactive agent-login routes. */
export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsRouteDeps,
): { refreshOpenCodeModels: () => Promise<void> } {
  // Discovery and credential edits must commit in order: a slow old-provider
  // response must never replace the new provider's model cache.
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = pending.then(action);
    pending = result.catch(() => undefined);
    return result;
  };
  let closed = false;
  const refreshOpenCodeModels = (): Promise<void> =>
    serialize(async () => {
      if (closed || deps.secretCipher?.isSealed() === true) return;
      try {
        const settings = await deps.store().getVeritySettings();
        const baseUrl = settings?.opencodeBaseUrl?.trim();
        const apiKey = settings?.opencodeApiKey?.trim();
        if (!settings || !baseUrl || !apiKey) return;
        const models = (await fetchOpenCodeModels(baseUrl, apiKey)).join('\n');
        if (closed || models === (settings.opencodeModels ?? '')) return;
        const updated = await deps.store().updateVeritySettings({ opencodeModels: models });
        try {
          await deps.onOpenCodeSettingsChanged?.(updated);
        } catch (error) {
          const restored = await deps.store().updateVeritySettings({
            opencodeModels: settings.opencodeModels ?? null,
          });
          await deps.onOpenCodeSettingsChanged?.(restored);
          throw error;
        }
      } catch {
        // Keep the last successful catalog during provider outages; never log
        // upstream errors that could contain credentials or response bodies.
        app.log.warn('Could not refresh OpenCode models; keeping the saved catalog');
      }
    });
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => {
    await refreshOpenCodeModels();
    refreshTimer = setInterval(() => void refreshOpenCodeModels(), 24 * 60 * 60 * 1_000);
    refreshTimer.unref();
  });
  app.addHook('onClose', async () => {
    closed = true;
    clearInterval(refreshTimer);
    await pending;
  });
  app.get('/settings', async () => {
    const settings = (await deps.store().getVeritySettingsRaw()) ?? null;
    return { settings: settings ? deps.publicSettings(settings) : null };
  });

  app.get('/settings/transcription', async () => {
    const settings = (await deps.store().getVeritySettingsRaw()) ?? null;
    const effective = deps.effectiveTranscription(settings);
    return {
      transcribeBackendMode: settings?.transcribeBackendMode ?? null,
      transcribeBaseUrl: effective.baseUrl,
      transcribeModel: effective.model,
      transcribeApiKeyConfigured: effective.apiKeyConfigured,
      transcribeLocalAvailable: false,
      transcribeExternalConfigured: deps.transcriptionConfigured(settings),
    };
  });

  app.patch('/settings/transcription/backend', async (request) => {
    const { mode } = transcriptionBackendBody.parse(request.body);
    await deps.store().updateTranscribeBackendMode(mode);
    return { mode };
  });

  app.patch('/settings', async (request) =>
    serialize(async () => {
      if (deps.secretCipher?.isSealed() === true) throw new SealedError();
      const patch = deps.parseSettingsPatch(request.body);
      const changesOpenCodeCredentials =
        patch.opencodeBaseUrl !== undefined || patch.opencodeApiKey !== undefined;
      const changesOpenCode =
        changesOpenCodeCredentials || patch.opencodeDisabledModels !== undefined;
      const previousOpenCode = changesOpenCode ? await deps.store().getVeritySettings() : undefined;
      if (patch.transcribeBaseUrl !== undefined && patch.transcribeApiKey === undefined) {
        const current = await deps.store().getVeritySettings();
        const currentBaseUrl = current?.transcribeBaseUrl?.trim() || null;
        const nextBaseUrl = patch.transcribeBaseUrl?.trim() || null;
        if (currentBaseUrl !== nextBaseUrl) patch.transcribeApiKey = null;
      }
      if (patch.opencodeBaseUrl !== undefined && patch.opencodeApiKey === undefined) {
        const current = await deps.store().getVeritySettings();
        const currentBaseUrl = current?.opencodeBaseUrl?.trim() || null;
        const nextBaseUrl = patch.opencodeBaseUrl?.trim() || null;
        if (currentBaseUrl !== nextBaseUrl) patch.opencodeApiKey = null;
      }
      if (changesOpenCodeCredentials) {
        const baseUrl = (
          patch.opencodeBaseUrl !== undefined
            ? patch.opencodeBaseUrl
            : previousOpenCode?.opencodeBaseUrl
        )?.trim();
        const apiKey = (
          patch.opencodeApiKey !== undefined
            ? patch.opencodeApiKey
            : previousOpenCode?.opencodeApiKey
        )?.trim();
        try {
          patch.opencodeModels =
            baseUrl && apiKey ? (await fetchOpenCodeModels(baseUrl, apiKey)).join('\n') : null;
          if (
            patch.opencodeBaseUrl !== undefined &&
            patch.opencodeBaseUrl?.trim() !== previousOpenCode?.opencodeBaseUrl?.trim()
          ) {
            patch.opencodeDisabledModels = null;
          }
        } catch (error) {
          throw Object.assign(
            new Error(
              error instanceof Error
                ? error.message
                : 'Could not load OpenCode models from the provider.',
            ),
            { statusCode: 502 },
          );
        }
      }
      if (patch.opencodeDisabledModels !== undefined && patch.opencodeDisabledModels !== null) {
        const catalog = new Set(
          (patch.opencodeModels ?? previousOpenCode?.opencodeModels ?? '')
            .split(/[\n,]/u)
            .map((model) => model.trim())
            .filter(Boolean),
        );
        patch.opencodeDisabledModels = [
          ...new Set(
            patch.opencodeDisabledModels
              .split(/[\n,]/u)
              .map((model) => model.trim())
              .filter((model) => catalog.has(model)),
          ),
        ].join('\n');
      }
      const containsAgentCredentials =
        patch.claudeCodeOauthCredentialsJson !== undefined || patch.codexAuthJson !== undefined;
      let settings: VeritySettingsRecord | undefined;
      if (containsAgentCredentials) {
        await deps.storeAgentCredentials(patch);
        settings = await deps.store().getVeritySettings();
      } else {
        settings = await deps.store().updateVeritySettings(patch);
      }
      if (settings === undefined) throw new Error('Verity settings disappeared after update');
      if (patch.uplinkSubscriptionKey !== undefined) deps.onUplinkCredentialsChanged?.();
      if (changesOpenCode) {
        try {
          await deps.onOpenCodeSettingsChanged?.(settings);
        } catch (error) {
          const current = await deps.store().getVeritySettings();
          if (
            current?.opencodeBaseUrl === settings.opencodeBaseUrl &&
            current?.opencodeApiKey === settings.opencodeApiKey &&
            current?.opencodeModels === settings.opencodeModels &&
            current?.opencodeDisabledModels === settings.opencodeDisabledModels
          ) {
            const restored = await deps.store().updateVeritySettings({
              opencodeBaseUrl: previousOpenCode?.opencodeBaseUrl ?? null,
              opencodeApiKey: previousOpenCode?.opencodeApiKey ?? null,
              opencodeModels: previousOpenCode?.opencodeModels ?? null,
              opencodeDisabledModels: previousOpenCode?.opencodeDisabledModels ?? null,
            });
            if (restored !== undefined) await deps.onOpenCodeSettingsChanged?.(restored);
          }
          throw error;
        }
      }
      return { settings: deps.publicSettings(settings) };
    }),
  );

  // Clearing all three stored credentials is the only supported way to reopen
  // GitHub manifest onboarding for a different App. Environment configuration
  // remains out-of-band and is intentionally untouched.
  app.post('/settings/github/disconnect', async (): Promise<{ disconnected: true }> => {
    // Updating settings reads the row back decrypted, even though this patch
    // contains only nulls, so expose the standard sealed-store response.
    if (deps.secretCipher?.isSealed() === true) throw new SealedError();
    await deps.store().updateVeritySettings({
      githubAppId: null,
      githubAppInstallationId: null,
      githubAppPrivateKey: null,
    });
    return { disconnected: true };
  });

  app.post('/settings/agent-logins/:provider/start', async (request) => {
    if (deps.secretCipher?.isSealed() === true) throw new SealedError();
    const { provider } = agentLoginProviderParam.parse(request.params);
    return { login: await deps.agentLogin.start(provider) };
  });

  app.delete('/settings/agent-logins/:provider', async (request) => {
    if (deps.secretCipher?.isSealed() === true) throw new SealedError();
    const { provider } = agentLoginProviderParam.parse(request.params);
    const patch: VeritySettingsPatch =
      provider === 'claude' ? { claudeCodeOauthCredentialsJson: null } : { codexAuthJson: null };
    await deps.storeAgentCredentials(patch);
    const settings = await deps.store().getVeritySettings();
    if (settings === undefined) throw new Error('Verity settings disappeared after agent logout');
    return { settings: deps.publicSettings(settings) };
  });

  app.get('/settings/agent-logins/:sessionId', async (request) => {
    const { sessionId } = agentLoginSessionParam.parse(request.params);
    return { login: await deps.agentLogin.get(sessionId) };
  });

  app.post('/settings/agent-logins/:sessionId/submit-code', async (request) => {
    if (deps.secretCipher?.isSealed() === true) throw new SealedError();
    const { sessionId } = agentLoginSessionParam.parse(request.params);
    const { code } = agentLoginCodeBody.parse(request.body);
    return { login: await deps.agentLogin.submitCode(sessionId, code) };
  });
  return { refreshOpenCodeModels };
}
