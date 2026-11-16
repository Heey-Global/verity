import { describe, expect, it, vi } from 'vitest';
import { administratorProviderConnections } from './administrator-provider-connections.js';
import { legacyAdministratorId } from './view-state-routes.js';

describe('original administrator AI accounts', () => {
  it('reports existing encrypted logins without reading or copying their secrets', async () => {
    const update = vi.fn();
    const accounts = administratorProviderConnections(
      {
        getVeritySettings: async () => undefined,
        getVeritySettingsRaw: async () =>
          ({
            claudeCodeOauthCredentialsJson: 'enc:v1:claude',
            codexAuthJson: 'enc:v1:codex',
            opencodeApiKey: 'enc:v1:opencode',
            opencodeBaseUrl: 'https://llm.example/v1',
            opencodeModels: 'one\ntwo',
            opencodeDisabledModels: 'two',
            updatedAt: new Date(0),
          }) as never,
      },
      update,
    );
    expect(accounts.owns(legacyAdministratorId)).toBe(true);
    expect(accounts.owns('member')).toBe(false);
    expect(await accounts.status()).toEqual([
      { provider: 'claude', baseUrl: null, models: null, updatedAt: new Date(0) },
      { provider: 'codex', baseUrl: null, models: null, updatedAt: new Date(0) },
      {
        provider: 'opencode',
        baseUrl: 'https://llm.example/v1',
        models: 'one',
        updatedAt: new Date(0),
      },
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it('uses the original persistence and refresh pipeline for changes and disconnects', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const accounts = administratorProviderConnections(
      { getVeritySettings: async () => undefined, getVeritySettingsRaw: async () => undefined },
      update,
    );
    await accounts.set('claude', { credential: 'renewed' });
    expect(update).toHaveBeenLastCalledWith({ claudeCodeOauthCredentialsJson: 'renewed' });
    await accounts.set('codex', { credential: 'rotated' });
    expect(update).toHaveBeenLastCalledWith({ codexAuthJson: 'rotated' });
    await accounts.delete('claude');
    expect(update).toHaveBeenLastCalledWith({ claudeCodeOauthCredentialsJson: null });
    await accounts.delete('codex');
    expect(update).toHaveBeenLastCalledWith({ codexAuthJson: null });
    await accounts.delete('opencode');
    expect(update).toHaveBeenLastCalledWith({
      opencodeApiKey: null,
      opencodeBaseUrl: null,
      opencodeModels: null,
      opencodeDisabledModels: null,
    });
  });
});

it('materializes OpenCode changes and disconnects, restoring a failed change', async () => {
  let settings = {
    opencodeBaseUrl: 'https://old.example/v1',
    opencodeApiKey: 'old-key',
    opencodeModels: 'old-model',
    opencodeDisabledModels: null,
  };
  const update = vi.fn(async (patch) => {
    settings = { ...settings, ...patch };
  });
  const changed = vi.fn(async () => undefined);
  const accounts = administratorProviderConnections(
    {
      getVeritySettings: async () => settings as never,
      getVeritySettingsRaw: async () => settings as never,
    },
    update,
    changed,
  );
  await accounts.set('opencode', {
    credential: 'new-key',
    baseUrl: 'https://new.example/v1',
    models: 'new-model',
  });
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ opencodeApiKey: 'new-key', opencodeModels: 'new-model' }),
  );
  changed.mockRejectedValueOnce(new Error('cannot materialize'));
  await expect(
    accounts.set('opencode', {
      credential: 'bad-key',
      baseUrl: 'https://bad.example/v1',
      models: 'bad-model',
    }),
  ).rejects.toThrow('cannot materialize');
  expect(settings.opencodeApiKey).toBe('new-key');
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ opencodeApiKey: 'new-key' }));
  await accounts.delete('opencode');
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ opencodeApiKey: null, opencodeModels: null }),
  );
});
