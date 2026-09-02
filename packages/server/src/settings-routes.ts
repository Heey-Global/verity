import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  SealableSecretCipher,
  VeritySettingsPatch,
  VeritySettingsRecord,
} from '@verity/store';
import { SealedError } from '@verity/store';
import type { AgentLoginService } from './agent-login.js';

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
}

export const SELECTABLE_TRANSCRIBE_BACKEND_MODES = ['external'] as const;

const transcriptionBackendBody = z.object({ mode: z.enum(SELECTABLE_TRANSCRIBE_BACKEND_MODES) });
const agentLoginProviderParam = z.object({ provider: z.enum(['claude', 'codex']) });
const agentLoginSessionParam = z.object({ sessionId: z.string().uuid() });
const agentLoginCodeBody = z.object({ code: z.string().trim().min(1).max(20_000) });

/** Public settings, transcription selection, and interactive agent-login routes. */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
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

  app.patch('/settings', async (request) => {
    if (deps.secretCipher?.isSealed() === true) throw new SealedError();
    const patch = deps.parseSettingsPatch(request.body);
    if (patch.transcribeBaseUrl !== undefined && patch.transcribeApiKey === undefined) {
      const current = await deps.store().getVeritySettings();
      const currentBaseUrl = current?.transcribeBaseUrl?.trim() || null;
      const nextBaseUrl = patch.transcribeBaseUrl?.trim() || null;
      if (currentBaseUrl !== nextBaseUrl) patch.transcribeApiKey = null;
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
    return { settings: deps.publicSettings(settings) };
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
}
