import { expect, it, vi } from 'vitest';
import { createProcessAgentLoginService } from './agent-login.js';
import { createServerAgentCredentials } from './server-agent-credentials.js';
import type { ServerContext } from './server-context.js';
import { legacyAdministratorId } from './view-state-routes.js';

vi.mock('./agent-login.js', () => ({
  createProcessAgentLoginService: vi.fn(() => ({ close: vi.fn() })),
}));

it('saves administrator sign-ins through the existing refresh boundary and members through personal storage', async () => {
  const updateVeritySettings = vi.fn();
  const set = vi.fn();
  const refreshBoundary = vi.fn(async (_patch, persist: () => Promise<void>) => persist());
  const personalBoundary = vi.fn(async (_user, _provider, write: () => Promise<void>) => write());
  createServerAgentCredentials({
    deps: {
      eventStore: {
        getVeritySettingsRaw: vi.fn(),
        getVeritySettings: vi.fn(),
        updateTranscribeBackendMode: vi.fn(),
        updateVeritySettings,
        userProviderConnections: { set },
      },
      persistAgentCredentials: refreshBoundary,
      persistPersonalProviderCredentials: personalBoundary,
    },
    lifecycle: { onClose: vi.fn() },
  } as unknown as ServerContext);
  const options = vi.mocked(createProcessAgentLoginService).mock.calls.at(-1)![0];
  await options.storePersonal!(legacyAdministratorId, 'claude', 'claude-renewed');
  expect(refreshBoundary).toHaveBeenCalledTimes(1);
  expect(updateVeritySettings).toHaveBeenLastCalledWith({
    claudeCodeOauthCredentialsJson: 'claude-renewed',
  });
  expect(set).not.toHaveBeenCalled();
  await options.storePersonal!('member', 'codex', 'member-login');
  expect(set).toHaveBeenCalledWith('member', 'codex', { credential: 'member-login' });
  expect(refreshBoundary).toHaveBeenCalledTimes(1);
});

it('connects administrator OpenCode writes to the live materialization callback', async () => {
  let settings = {};
  const changed = vi.fn();
  const credentials = createServerAgentCredentials({
    deps: {
      eventStore: {
        getVeritySettingsRaw: async () => settings,
        getVeritySettings: async () => settings,
        updateVeritySettings: async (patch: object) => {
          settings = { ...settings, ...patch };
        },
        updateTranscribeBackendMode: vi.fn(),
      },
      onOpenCodeSettingsChanged: changed,
    },
    lifecycle: { onClose: vi.fn() },
  } as unknown as ServerContext);
  await credentials.administratorAccounts.set('opencode', {
    credential: 'key',
    baseUrl: 'https://llm.example/v1',
    models: 'model',
  });
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({
      opencodeBaseUrl: 'https://llm.example/v1',
      opencodeModels: 'model',
      opencodeApiKey: 'key',
    }),
  );
});
