import type {
  EventStore,
  ProviderConnectionKind,
  VeritySettingsPatch,
  VeritySettingsRecord,
} from '@verity/store';
import { selectedOpenCodeModels } from './opencode-model-selection.js';
import { legacyAdministratorId } from './view-state-routes.js';

/**
 * The original provider logins belong to the original administrator. Keep their
 * encrypted storage and refresh pipeline: copying refresh tokens into a second
 * store would let two refreshers rotate the same account independently.
 */
export function administratorProviderConnections(
  store: Pick<EventStore, 'getVeritySettingsRaw' | 'getVeritySettings'>,
  update: (patch: VeritySettingsPatch) => Promise<void>,
  onOpenCodeSettingsChanged?: (settings: VeritySettingsRecord) => void | Promise<void>,
) {
  const apply = async (provider: ProviderConnectionKind, patch: VeritySettingsPatch) => {
    if (provider !== 'opencode' || onOpenCodeSettingsChanged === undefined) return update(patch);
    const previous = await store.getVeritySettings();
    await update(patch);
    const settings = await store.getVeritySettings();
    if (settings === undefined) throw new Error('Verity settings disappeared after update');
    try {
      await onOpenCodeSettingsChanged(settings);
    } catch (error) {
      const current = await store.getVeritySettings();
      const fields = [
        'opencodeBaseUrl',
        'opencodeApiKey',
        'opencodeModels',
        'opencodeDisabledModels',
      ] as const;
      // A failed materialization may roll back its own write, never a newer connection.
      if (current !== undefined && fields.every((field) => current[field] === settings[field])) {
        await update({
          opencodeBaseUrl: previous?.opencodeBaseUrl ?? null,
          opencodeApiKey: previous?.opencodeApiKey ?? null,
          opencodeModels: previous?.opencodeModels ?? null,
          opencodeDisabledModels: previous?.opencodeDisabledModels ?? null,
        });
        const restored = await store.getVeritySettings();
        if (restored !== undefined) await onOpenCodeSettingsChanged(restored);
      }
      throw error;
    }
  };
  return {
    owns: (userId: string) => userId === legacyAdministratorId,
    async status() {
      const settings = await store.getVeritySettingsRaw();
      const updatedAt = settings?.updatedAt ?? new Date(0);
      const connections = [];
      if (settings?.claudeCodeOauthCredentialsJson?.trim())
        connections.push({ provider: 'claude' as const, baseUrl: null, models: null, updatedAt });
      if (settings?.codexAuthJson?.trim())
        connections.push({ provider: 'codex' as const, baseUrl: null, models: null, updatedAt });
      if (settings?.opencodeApiKey?.trim() && settings.opencodeBaseUrl?.trim())
        connections.push({
          provider: 'opencode' as const,
          baseUrl: settings.opencodeBaseUrl,
          models: selectedOpenCodeModels(settings).join('\n'),
          updatedAt,
        });
      return connections;
    },
    set(
      provider: ProviderConnectionKind,
      input: {
        credential: string;
        baseUrl?: string;
        models?: string;
      },
    ) {
      return apply(
        provider,
        provider === 'claude'
          ? { claudeCodeOauthCredentialsJson: input.credential }
          : provider === 'codex'
            ? { codexAuthJson: input.credential }
            : {
                opencodeApiKey: input.credential,
                opencodeBaseUrl: input.baseUrl,
                opencodeModels: input.models,
                opencodeDisabledModels: null,
              },
      );
    },
    delete(provider: ProviderConnectionKind) {
      return apply(
        provider,
        provider === 'claude'
          ? { claudeCodeOauthCredentialsJson: null }
          : provider === 'codex'
            ? { codexAuthJson: null }
            : {
                opencodeApiKey: null,
                opencodeBaseUrl: null,
                opencodeModels: null,
                opencodeDisabledModels: null,
              },
      );
    },
  };
}
