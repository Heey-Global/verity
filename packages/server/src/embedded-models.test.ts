import type { VeritySettingsRecord } from '@verity/store';
import { CODEX_DEFAULT_MODEL } from '@verity/session';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createEmbeddedModels, installEmbeddedModels } from './embedded-models.js';
import { ensureOpenCodeSettingsMaterialized, materializeOpenCodeSettings } from './provisioner.js';

vi.mock('./provisioner.js', () => ({
  ensureOpenCodeSettingsMaterialized: vi.fn(),
  materializeOpenCodeSettings: vi.fn(),
}));

type Context = Parameters<typeof createEmbeddedModels>[0];
const catalogs: Awaited<ReturnType<typeof createEmbeddedModels>>[] = [];
async function fixture(config: Context['config'] = {}) {
  const eventStore = {
    getVeritySettings: vi
      .fn<Context['eventStore']['getVeritySettings']>()
      .mockResolvedValue(undefined),
    getVeritySettingsRaw: vi
      .fn<Context['eventStore']['getVeritySettingsRaw']>()
      .mockResolvedValue(undefined),
  };
  const models = await createEmbeddedModels({ config, eventStore, secretRoot: '/test/secrets' });
  catalogs.push(models);
  return { models, eventStore };
}
afterEach(async () => {
  for (const models of catalogs.splice(0)) await models.codexModelCatalog?.close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('materializes boot configuration conservatively and unlock configuration authoritatively', async () => {
  const { models, eventStore } = await fixture({ claudeConnectorPort: 12345 });
  expect(ensureOpenCodeSettingsMaterialized).toHaveBeenCalledWith(
    undefined,
    '/test/secrets',
    12345,
  );
  expect(materializeOpenCodeSettings).not.toHaveBeenCalled();
  await models.materializeOpenCodeConfig('secret unlock');
  expect(eventStore.getVeritySettings).toHaveBeenCalledTimes(2);
  expect(materializeOpenCodeSettings).toHaveBeenCalledWith(undefined, '/test/secrets', 12345);
});

it('keeps boot and unlock settings failures nonfatal with reason-specific diagnostics', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = new Error('sealed');
  const eventStore = {
    getVeritySettings: vi
      .fn<Context['eventStore']['getVeritySettings']>()
      .mockRejectedValue(failure),
    getVeritySettingsRaw: vi.fn<Context['eventStore']['getVeritySettingsRaw']>(),
  };
  const models = await createEmbeddedModels({
    config: {},
    eventStore,
    secretRoot: '/test/secrets',
  });
  await expect(models.materializeOpenCodeConfig('secret unlock')).resolves.toBeUndefined();
  expect(warning).toHaveBeenCalledWith(
    'verity: OpenCode configuration not materialized (boot)',
    failure,
  );
  expect(warning).toHaveBeenCalledWith(
    'verity: OpenCode configuration not materialized (secret unlock)',
    failure,
  );
});

it('does not load a catalog for disabled or explicitly configured Codex models', async () => {
  const load = vi.fn().mockResolvedValue(['codex/discovered']);
  const disabled = await fixture({ codexBundledModelLoader: load });
  expect(await disabled.models.bindings.listModels?.()).toEqual([]);
  const explicit = await fixture({
    codexEnabled: true,
    codexModels: ['codex/selected'],
    codexBundledModelLoader: load,
  });
  expect(await explicit.models.bindings.listModels?.()).toEqual(['codex/selected']);
  const empty = await fixture({
    codexEnabled: true,
    codexModels: [],
    codexBundledModelLoader: load,
  });
  expect(await empty.models.bindings.listModels?.()).toEqual([]);
  expect(load).not.toHaveBeenCalled();
});

it('awaits initial discovery and closes the catalog at the installed lifecycle hook', async () => {
  const load = vi.fn().mockResolvedValue(['codex/discovered']);
  const { models } = await fixture({ codexEnabled: true, codexBundledModelLoader: load });
  expect(load).toHaveBeenCalledTimes(1);
  expect(await models.bindings.listModels?.()).toEqual([CODEX_DEFAULT_MODEL, 'codex/discovered']);
  const app = Fastify();
  try {
    installEmbeddedModels(app, models);
    await app.close();
    await models.codexModelCatalog?.refresh();
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

it('retains the fallback after a failed initial catalog read', async () => {
  const failure = new Error('catalog unavailable');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { models } = await fixture({
    codexEnabled: true,
    codexBundledModelLoader: async () => {
      throw failure;
    },
  });
  expect(await models.bindings.listModels?.()).toEqual([CODEX_DEFAULT_MODEL]);
  expect(warn).toHaveBeenCalledWith(
    'verity: Codex model catalog refresh failed; keeping cached models',
    failure,
  );
});

it('reads current OpenCode settings for each model query and requires all provider fields', async () => {
  const { models, eventStore } = await fixture();
  const settings = {
    opencodeBaseUrl: 'https://provider.example',
    opencodeApiKey: 'test-key',
    opencodeModels: 'one,two',
  } as VeritySettingsRecord;
  eventStore.getVeritySettingsRaw.mockResolvedValue(settings);
  expect(await models.bindings.listModels?.()).toEqual(['verity/one', 'verity/two']);
  for (const field of ['opencodeBaseUrl', 'opencodeApiKey', 'opencodeModels']) {
    eventStore.getVeritySettingsRaw.mockResolvedValue({ ...settings, [field]: '  ' });
    expect(await models.bindings.listModels?.()).toEqual([]);
  }
});
