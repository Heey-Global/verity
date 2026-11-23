import { CODEX_DEFAULT_MODEL } from '@verity/session';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { fetchCodexBundledModels, startCodexModelCatalog } from './codex-model-catalog.js';
import { ensureOpenCodeSettingsMaterialized, materializeOpenCodeSettings } from './provisioner.js';
import { selectedOpenCodeModels } from './opencode-model-selection.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { ServerDeps } from './server-deps.js';

export async function createEmbeddedModels({
  config,
  eventStore,
  secretRoot,
}: {
  config: Pick<
    EmbeddedServerConfig,
    'codexEnabled' | 'codexModels' | 'codexBundledModelLoader' | 'claudeConnectorPort'
  >;
  eventStore: Pick<EventStore, 'getVeritySettings' | 'getVeritySettingsRaw'>;
  secretRoot: string;
}) {
  // Runners mount `<secretRoot>/opencode/opencode.json` before their first turn,
  // so boot must provide the file even when settings have never been saved.
  //
  // At boot the write withholds only the credential-free fallback, and only when a
  // file is already there: a sealed boot cannot tell "no provider configured" from
  // "the settings are encrypted", and answering the second with the fallback would
  // disable OpenCode until someone re-saved the settings.
  // `ensureOpenCodeSettingsMaterialized` holds that rule and is tested on it. Unlock
  // is unconditional — the settings are authoritative by then, including a provider
  // that was removed. Reading settings can itself fail on a sealed store, so neither
  // path may take the Server down with it.
  const materializeOpenCodeConfig = async (reason: 'boot' | 'secret unlock'): Promise<void> => {
    try {
      const settings = await eventStore.getVeritySettings();
      if (reason === 'boot') {
        ensureOpenCodeSettingsMaterialized(settings, secretRoot, config.claudeConnectorPort);
        return;
      }
      materializeOpenCodeSettings(settings, secretRoot, config.claudeConnectorPort);
    } catch (error) {
      console.warn(`verity: OpenCode configuration not materialized (${reason})`, error);
    }
  };
  await materializeOpenCodeConfig('boot');
  const configuredCodexModels =
    config.codexEnabled === true ? (config.codexModels ?? [CODEX_DEFAULT_MODEL]) : [];
  const codexModelCatalog =
    config.codexEnabled === true && config.codexModels === undefined
      ? startCodexModelCatalog({
          fallback: configuredCodexModels,
          // The Server has no project mTLS identity and must never materialize the
          // subscription login merely to enumerate models. The binary's bundled
          // catalog is credential-free and is refreshed after upgrades.
          load: () => (config.codexBundledModelLoader ?? fetchCodexBundledModels)(),
          onError: (error) =>
            console.warn(
              'verity: Codex model catalog refresh failed; keeping cached models',
              error,
            ),
        })
      : undefined;
  if (codexModelCatalog !== undefined) await codexModelCatalog.refresh();
  const openCodeModels = async (): Promise<string[]> => {
    const settings = await eventStore.getVeritySettingsRaw();
    if (
      !settings?.opencodeBaseUrl?.trim() ||
      !settings.opencodeApiKey?.trim() ||
      !settings.opencodeModels?.trim()
    ) {
      return [];
    }
    return selectedOpenCodeModels(settings).map((model) => `verity/${model}`);
  };

  const bindings: Pick<ServerDeps, 'listModels'> = {
    listModels: async () => [
      ...(codexModelCatalog?.list() ?? configuredCodexModels),
      ...(await openCodeModels()),
    ],
  };
  return { materializeOpenCodeConfig, codexModelCatalog, bindings };
}

export function installEmbeddedModels(
  app: FastifyInstance,
  ctx: Pick<Awaited<ReturnType<typeof createEmbeddedModels>>, 'codexModelCatalog'>,
): void {
  const { codexModelCatalog } = ctx;
  if (codexModelCatalog !== undefined) {
    app.addHook('onClose', () => codexModelCatalog.close());
  }
}
