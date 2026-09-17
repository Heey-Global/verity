import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VeritySettingsPatch, VeritySettingsRecord } from '@verity/store';
import type { AgentLoginService } from './agent-login.js';
import { registerSettingsRoutes } from './settings-routes.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(initial: Partial<VeritySettingsRecord> = {}) {
  let settings = { ...initial } as VeritySettingsRecord;
  const store = {
    getVeritySettingsRaw: async () => settings,
    getVeritySettings: async () => settings,
    updateVeritySettings: async (patch: VeritySettingsPatch) => {
      settings = Object.assign({}, settings, patch);
      return settings;
    },
    updateTranscribeBackendMode: async () => {},
  };
  const app = Fastify();
  apps.push(app);
  const changed = vi.fn();
  const { refreshOpenCodeModels } = registerSettingsRoutes(app, {
    store: () => store,
    agentLogin: {} as AgentLoginService,
    parseSettingsPatch: (body) => body as VeritySettingsPatch,
    storeAgentCredentials: async () => {},
    publicSettings: (value) => ({ ...value, opencodeApiKey: undefined }),
    effectiveTranscription: () => ({ baseUrl: null, model: null, apiKeyConfigured: false }),
    transcriptionConfigured: () => false,
    onOpenCodeSettingsChanged: changed,
  });
  await app.ready();
  return { app, store, changed, refreshOpenCodeModels };
}

const credentials = { opencodeBaseUrl: 'https://provider.example/v1', opencodeApiKey: 'test-key' };
const catalog = (...ids: string[]) => Response.json({ data: ids.map((id) => ({ id })) });

describe('automatic OpenCode settings models', () => {
  it('discovers and materializes the full catalog when saving only URL and key', async () => {
    const fetcher = vi.fn().mockResolvedValue(catalog('provider/one', 'provider/two'));
    vi.stubGlobal('fetch', fetcher);
    const { app, store, changed } = await setup();
    const response = await app.inject({ method: 'PATCH', url: '/settings', payload: credentials });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.opencodeModels).toBe('provider/one\nprovider/two');
    expect((await store.getVeritySettings()).opencodeModels).toBe('provider/one\nprovider/two');
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ opencodeModels: 'provider/one\nprovider/two' }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps endpoint-only setup possible and clears stale models on provider changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(catalog('old')));
    const { app, store } = await setup({ ...credentials, opencodeModels: 'old' });
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: {
        opencodeBaseUrl: 'https://new-provider.example/v1',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(await store.getVeritySettings()).toMatchObject({
      opencodeApiKey: null,
      opencodeModels: null,
    });
  });

  it('leaves saved credentials and models intact when discovery fails', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(catalog('old'))
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const { app, store, changed } = await setup({ ...credentials, opencodeModels: 'old' });
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { opencodeApiKey: 'rejected-key' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().message).toContain('HTTP 401');
    expect(await store.getVeritySettings()).toMatchObject({
      ...credentials,
      opencodeModels: 'old',
    });
    expect(changed).not.toHaveBeenCalled();
  });

  it('replaces legacy lists at startup and preserves the cache only on refresh failures', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(catalog('new', 'another'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(catalog());
    vi.stubGlobal('fetch', fetcher);
    const { store, changed, refreshOpenCodeModels } = await setup({
      ...credentials,
      opencodeModels: 'legacy',
    });
    expect((await store.getVeritySettings()).opencodeModels).toBe('new\nanother');
    await refreshOpenCodeModels();
    expect((await store.getVeritySettings()).opencodeModels).toBe('new\nanother');
    await refreshOpenCodeModels();
    expect((await store.getVeritySettings()).opencodeModels).toBe('');
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('rolls back credentials and models together if configuration projection fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(catalog('new')));
    const { app, store, changed } = await setup();
    changed.mockRejectedValueOnce(new Error('projection failed'));
    const response = await app.inject({ method: 'PATCH', url: '/settings', payload: credentials });
    expect(response.statusCode).toBe(500);
    expect(await store.getVeritySettings()).toMatchObject({
      opencodeBaseUrl: null,
      opencodeApiKey: null,
      opencodeModels: null,
    });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('refreshes once daily and stops polling when the server closes', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(catalog('first'))
      .mockResolvedValueOnce(catalog('added'));
    vi.stubGlobal('fetch', fetcher);
    const { app, store } = await setup(credentials);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000 - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await store.getVeritySettings()).opencodeModels).toBe('added');
    await app.close();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('serializes background discovery with provider changes', async () => {
    let resolveRefresh!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(catalog('old'))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce(catalog('new'));
    vi.stubGlobal('fetch', fetcher);
    const { app, store, refreshOpenCodeModels } = await setup({
      ...credentials,
      opencodeModels: 'old',
    });
    const refresh = refreshOpenCodeModels();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const save = app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: {
        opencodeBaseUrl: 'https://new-provider.example/v1',
        opencodeApiKey: 'new-key',
      },
    });
    resolveRefresh(catalog('stale'));
    await refresh;
    expect((await save).statusCode).toBe(200);
    expect(await store.getVeritySettings()).toMatchObject({
      opencodeApiKey: 'new-key',
      opencodeModels: 'new',
    });
  });
});
