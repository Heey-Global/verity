import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VeritySettingsPatch, VeritySettingsRecord } from '@verity/store';
import type { AgentLoginService } from './agent-login.js';
import { claudeSubscriptionPlan } from './agent-subscription.js';
import { registerSettingsRoutes, type SettingsRouteDeps } from './settings-routes.js';
import { applyPremiumFeatureSwitches } from './premium-feature-switches.js';

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
  const switchesChanged = vi.fn();
  const uplinkChanged = vi.fn();
  const { refreshOpenCodeModels } = registerSettingsRoutes(app, {
    store: () => store,
    agentLogin: {} as AgentLoginService,
    parseSettingsPatch: (body) => body as VeritySettingsPatch,
    storeAgentCredentials: async () => {},
    publicSettings: (value) => ({ ...value, opencodeApiKey: undefined }),
    effectiveTranscription: () => ({ baseUrl: null, model: null, apiKeyConfigured: false }),
    transcriptionConfigured: () => false,
    onOpenCodeSettingsChanged: changed,
    onUplinkCredentialsChanged: uplinkChanged,
    onPremiumFeatureSwitchesChanged: switchesChanged,
  });
  await app.ready();
  return { app, store, changed, switchesChanged, uplinkChanged, refreshOpenCodeModels };
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

  it('stores model exclusions while leaving later discoveries enabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(catalog('provider/one', 'provider/two')));
    const { app, store, changed, refreshOpenCodeModels } = await setup({
      ...credentials,
      opencodeModels: 'provider/one\nprovider/two',
    });
    changed.mockClear();
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { opencodeDisabledModels: 'provider/two\nunknown/model' },
    });
    expect(response.statusCode).toBe(200);
    expect((await store.getVeritySettings()).opencodeDisabledModels).toBe('provider/two');
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ opencodeDisabledModels: 'provider/two' }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(catalog('provider/one', 'provider/two', 'provider/new')),
    );
    await refreshOpenCodeModels();
    expect(await store.getVeritySettings()).toMatchObject({
      opencodeModels: 'provider/one\nprovider/two\nprovider/new',
      opencodeDisabledModels: 'provider/two',
    });
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

// The plan labels are derived from inside encrypted credentials. Fed the raw
// row, the projection sees ciphertext and every plan silently reads as unknown;
// fed the decrypted one while sealed, the screen that unlocks the store would
// fail to load.
describe('GET /settings subscription plans', () => {
  const plaintext = JSON.stringify({
    claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
  });

  async function plansApp(opts: { sealed: boolean; decryptFails?: boolean }) {
    const getVeritySettings = vi.fn(async () => {
      if (opts.decryptFails) throw new Error('decrypt failed');
      return { claudeCodeOauthCredentialsJson: plaintext } as VeritySettingsRecord;
    });
    const app = Fastify();
    apps.push(app);
    registerSettingsRoutes(app, {
      store: () => ({
        getVeritySettingsRaw: async () =>
          ({ claudeCodeOauthCredentialsJson: 'v1:ciphertext' }) as VeritySettingsRecord,
        getVeritySettings,
        updateVeritySettings: async () => ({}) as VeritySettingsRecord,
        updateTranscribeBackendMode: async () => {},
      }),
      agentLogin: {} as AgentLoginService,
      secretCipher: { isSealed: () => opts.sealed } as SettingsRouteDeps['secretCipher'],
      parseSettingsPatch: (body) => body as VeritySettingsPatch,
      storeAgentCredentials: async () => {},
      publicSettings: (value) => ({
        claudeSubscriptionPlan: claudeSubscriptionPlan(value.claudeCodeOauthCredentialsJson),
      }),
      effectiveTranscription: () => ({ baseUrl: null, model: null, apiKeyConfigured: false }),
      transcriptionConfigured: () => false,
    });
    await app.ready();
    return { app, getVeritySettings };
  }

  it('derives the plan from the decrypted login while the store is open', async () => {
    const { app } = await plansApp({ sealed: false });
    const response = await app.inject({ method: 'GET', url: '/settings' });
    expect(response.json().settings.claudeSubscriptionPlan).toBe('Max 5x');
  });

  it('stays readable while sealed and leaves the plan blank', async () => {
    const { app, getVeritySettings } = await plansApp({ sealed: true });
    const response = await app.inject({ method: 'GET', url: '/settings' });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.claudeSubscriptionPlan).toBeNull();
    expect(getVeritySettings).not.toHaveBeenCalled();
  });

  it('falls back to the raw row when decryption fails', async () => {
    const { app } = await plansApp({ sealed: false, decryptFails: true });
    const response = await app.inject({ method: 'GET', url: '/settings' });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.claudeSubscriptionPlan).toBeNull();
  });
});

// The switch is only half the feature: a write that lands in the row but never
// reaches the Uplink client leaves remote sessions open and shares public until
// the next restart, while the app already shows "Off".
describe('PATCH /settings premium feature switches', () => {
  it('applies the stored switches after either of them changes', async () => {
    const { app, switchesChanged, uplinkChanged } = await setup({
      premiumSharingEnabled: true,
      premiumRemoteAccessEnabled: true,
    });
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { premiumRemoteAccessEnabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(switchesChanged).toHaveBeenCalledTimes(1);
    expect(switchesChanged.mock.calls[0]?.[0]).toMatchObject({
      premiumSharingEnabled: true,
      premiumRemoteAccessEnabled: false,
    });
    // A credential reset would revoke public links when only remote access changes.
    expect(uplinkChanged).not.toHaveBeenCalled();
  });

  it('leaves the switches alone when only the subscription key changes', async () => {
    const { app, switchesChanged, uplinkChanged } = await setup();
    await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { uplinkSubscriptionKey: 'subscription-fixture' },
    });
    expect(uplinkChanged).toHaveBeenCalledTimes(1);
    expect(switchesChanged).not.toHaveBeenCalled();
  });
});

it('retries public-link revocation after a failed settings PATCH already stored sharing off', async () => {
  const { app, switchesChanged } = await setup({ premiumSharingEnabled: true });
  let switches = { sharing: true, remoteAccess: true };
  const client = {
    featureSwitches: () => switches,
    applyFeatureSwitches: (next: typeof switches) => {
      switches = next;
    },
  };
  const shares = {
    disableAll: vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('could not list public shares')),
  };
  switchesChanged.mockImplementation((settings: VeritySettingsRecord) =>
    applyPremiumFeatureSwitches(settings, client, shares),
  );
  const request = {
    method: 'PATCH' as const,
    url: '/settings',
    payload: { premiumSharingEnabled: false },
  };
  expect((await app.inject(request)).statusCode).toBe(500);
  expect(switches.sharing).toBe(false);
  expect(
    (await app.inject({ method: 'GET', url: '/settings' })).json().settings.premiumSharingEnabled,
  ).toBe(false);
  expect((await app.inject(request)).statusCode).toBe(200);
  expect(shares.disableAll).toHaveBeenCalledTimes(2);
});
