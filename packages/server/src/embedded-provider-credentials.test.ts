import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SealedError, type VeritySettingsRecord } from '@verity/store';
import {
  createEmbeddedPersonalProviderCredentials,
  createEmbeddedClaudeCredentialSync,
  createEmbeddedProviderCredentialBindings,
} from './embedded-provider-credentials.js';
import { sandboxPersonTag } from './sandbox-identity.js';
import { materializePersonalOpenCodeSettings, personalOpenCodeSubdir } from './provisioner.js';
import { startClaudeCredentialSync } from './embedded-support.js';
import { readCodexAccessToken } from './agent-gateway-control.js';

vi.mock('./embedded-support.js', async (original) => ({
  ...(await original<typeof import('./embedded-support.js')>()),
  startClaudeCredentialSync: vi.fn(),
}));
vi.mock('./agent-gateway-control.js', async (original) => ({
  ...(await original<typeof import('./agent-gateway-control.js')>()),
  readCodexAccessToken: vi.fn(),
}));

type Bindings = Parameters<typeof createEmbeddedProviderCredentialBindings>[0];
const directories: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'verity-provider-'));
  directories.push(root);
  return root;
}
beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function fixture(secretRoot = '/unused') {
  const context: Bindings = {
    secretRoot,
    config: { claudeConnectorPort: 9444 },
    claudeCredentialSync: {
      persistCredentials: vi.fn<Bindings['claudeCredentialSync']['persistCredentials']>(
        async (_patch, persist) => persist(),
      ),
      getAccessToken: vi.fn(async () => 'claude-token'),
    },
    personalProviderCredentials: {
      claudeAccessToken: vi.fn(async () => 'personal-token'),
      persist: vi.fn<Bindings['personalProviderCredentials']['persist']>(
        async (_userId, _provider, write) => write(),
      ),
    },
    refreshAgentGatewayCredential: vi.fn(async () => {}),
    codexModelCatalog: { refresh: vi.fn(async () => {}) },
    codexGatewayCredentialProvider: undefined,
    codexGatewayControlSocket: undefined,
  };
  return { context, bindings: createEmbeddedProviderCredentialBindings(context) };
}

describe('embedded provider credentials', () => {
  it('rewrites active personal models and revokes stale mounted configurations', async () => {
    const secretRoot = await directory();
    const liveTag = sandboxPersonTag('live');
    const staleTag = sandboxPersonTag('removed');
    const staleConnection = { baseUrl: 'https://provider.example/v1', models: 'old-model' };
    materializePersonalOpenCodeSettings(staleConnection, secretRoot, staleTag, 9444);
    const listByProvider = vi.fn(async () => [
      { userId: 'live', baseUrl: 'https://provider.example/v1', models: 'new-model' },
    ]);
    const store = {
      isActiveLocalUser: vi.fn(async () => true),
      userProviderConnections: { listByProvider },
    } as unknown as Parameters<typeof createEmbeddedPersonalProviderCredentials>[0]['store'];
    const credentials = createEmbeddedPersonalProviderCredentials({
      store,
      secretRoot,
      config: { claudeConnectorPort: 9444 },
    });
    await credentials.persist('live', 'opencode', async () => {});
    await vi.waitFor(async () => {
      const live = await readFile(
        join(secretRoot, personalOpenCodeSubdir(liveTag), 'opencode.json'),
        'utf8',
      );
      const stale = await readFile(
        join(secretRoot, personalOpenCodeSubdir(staleTag), 'opencode.json'),
        'utf8',
      );
      expect(live).toContain('new-model');
      expect(stale).not.toContain('old-model');
      expect(stale).not.toContain('provider');
    });
    expect(listByProvider).toHaveBeenCalledWith('opencode');
  });

  it('starts the existing Claude queue and suppresses sealed-store diagnostics', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = {} as ReturnType<typeof startClaudeCredentialSync>;
    vi.mocked(startClaudeCredentialSync).mockReturnValue(service);
    const store = {} as Parameters<typeof startClaudeCredentialSync>[0];
    expect(createEmbeddedClaudeCredentialSync(store, '/secrets')).toBe(service);
    const [passedStore, root, onError] = vi.mocked(startClaudeCredentialSync).mock.calls[0]!;
    expect(passedStore).toBe(store);
    expect(root).toBe('/secrets');
    onError!(new SealedError());
    expect(warn).not.toHaveBeenCalled();
    onError!(new Error('refresh failed'));
    expect(warn).toHaveBeenCalledOnce();
  });

  it('waits for credential publication before refreshing the Codex catalog', async () => {
    const { context, bindings } = fixture();
    let release!: () => void;
    const publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(context.claudeCredentialSync.persistCredentials).mockReturnValue(publication);
    const pending = bindings.persistAgentCredentials!({ codexAuthJson: 'updated' }, async () => {});
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(context.codexModelCatalog!.refresh).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect(context.codexModelCatalog!.refresh).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, 'updated'])(
    'refreshes the Codex catalog only for a Codex patch (%s)',
    async (codexAuthJson) => {
      const { context, bindings } = fixture();
      const persist = vi.fn(async () => {});
      await bindings.persistAgentCredentials!({ codexAuthJson }, persist);
      expect(persist).toHaveBeenCalledOnce();
      expect(context.codexModelCatalog!.refresh).toHaveBeenCalledTimes(
        codexAuthJson === undefined ? 0 : 1,
      );
    },
  );

  it('retains the person and provider when routing personal credential calls', async () => {
    const { context, bindings } = fixture();
    const write = vi.fn(async () => {});
    expect(bindings.claudeOAuthTokenProvider).toBe(context.claudeCredentialSync.getAccessToken);
    expect(await bindings.personalClaudeAccessToken!('person')).toBe('personal-token');
    await bindings.persistPersonalProviderCredentials!('person', 'opencode', write);
    expect(context.personalProviderCredentials.claudeAccessToken).toHaveBeenCalledWith('person');
    expect(context.personalProviderCredentials.persist).toHaveBeenCalledWith(
      'person',
      'opencode',
      write,
    );
  });

  it('leaves Codex probing absent without a gateway and scopes enabled probes to the person', async () => {
    const { context, bindings } = fixture();
    expect(bindings).not.toHaveProperty('codexGatewayCredentialFor');
    expect(bindings).not.toHaveProperty('codexGatewayCredentialProvider');
    context.codexGatewayControlSocket = '/gateway.sock';
    const enabled = createEmbeddedProviderCredentialBindings(context);
    expect(readCodexAccessToken).not.toHaveBeenCalled();
    await enabled.codexGatewayCredentialFor!('person')();
    expect(readCodexAccessToken).toHaveBeenCalledWith('/gateway.sock', 'person');
  });

  it('materializes instance OpenCode settings before asking the gateway to refresh', async () => {
    const secretRoot = await directory();
    const { context, bindings } = fixture(secretRoot);
    vi.mocked(context.refreshAgentGatewayCredential).mockImplementation(async () => {
      expect(await readFile(join(secretRoot, 'opencode', 'opencode.json'), 'utf8')).toContain(
        'model',
      );
    });
    await bindings.onOpenCodeSettingsChanged!({
      opencodeBaseUrl: 'https://provider.example/v1',
      opencodeApiKey: 'key',
      opencodeModels: 'model',
    } as VeritySettingsRecord);
    expect(context.refreshAgentGatewayCredential).toHaveBeenCalledOnce();
  });
});
