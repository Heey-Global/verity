// Shared harness for the five Settings route suites.
//
// Settings is no longer one screen, so the fixtures and module mocks it needs
// are no longer one file's private business either. They live here so the five
// suites agree on what a configured server looks like — a fixture that drifts
// per file is how a screen ends up green against settings no server would send.
//
// The `*Mock()` functions are the module factories the suites hand to
// `jest.mock`. They are required lazily from inside those factories (jest hoists
// the `jest.mock` calls above every import, so nothing here can be referenced
// directly from one), which is also why the mock functions are exported: a suite
// imports them normally and gets the very same instances the factories close
// over.
import type { ProjectRecord, SecretStatus, VerityClient, VeritySettings } from '@verity/mobile';

import { resetVeritySettingsStore } from '../../lib/settingsStore';

/** The address `lib/client` is mocked to report. Assertions that render it
 *  should read it from here rather than spell it again. */
export const VERITY_BASE_URL = 'http://verity.test:8082';

export const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
export const mockCheckForAppUpdate = jest.fn();
export const mockPush = jest.fn<void, [string]>();
export const mockReplace = jest.fn<void, [string]>();
export const mockBack = jest.fn<void, []>();
export const mockDismissTo = jest.fn<void, [string]>();
// Both are awaited by their callers, so they resolve rather than return
// `undefined` — here and again after every reset.
export const mockOpenURL = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
const mockSetStringAsync = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);

let searchParams: Record<string, string | string[]> = {};
const focusCallbacks = new Set<() => void>();

/** Stand in for arriving on a route through a deep link. Call before `render`. */
export function setSearchParams(params: Record<string, string | string[]>): void {
  searchParams = params;
}

/** Re-run every mounted `useFocusEffect` — navigating back to this screen. */
export function refocus(): void {
  for (const callback of focusCallbacks) callback();
}

/**
 * expo-router, reduced to what the settings routes actually use.
 *
 * `Stack.Screen` is a navigation-config sink with no host output, so a
 * null-rendering stub keeps it out of the tree. `useFocusEffect` fires once on
 * mount and stays registered, which is close enough to focus for screens that
 * use it to re-read server state.
 */
export function expoRouterMock(): Record<string, unknown> {
  const react = require('react') as typeof import('react');
  return {
    Stack: { Screen: () => null },
    router: {
      push: (href: string) => mockPush(href),
      replace: (href: string) => mockReplace(href),
      back: () => mockBack(),
      dismissTo: (href: string) => mockDismissTo(href),
    },
    useFocusEffect: (cb: () => void) =>
      react.useEffect(() => {
        focusCallbacks.add(cb);
        cb();
        return () => {
          focusCallbacks.delete(cb);
        };
      }, [cb]),
    useLocalSearchParams: () => searchParams,
  };
}

/** `lib/client`, so no suite ever opens a socket. */
export function clientMock(): Record<string, unknown> {
  return {
    createVerityClient: () => mockCreateVerityClient(),
    getVerityBaseUrl: () => VERITY_BASE_URL,
  };
}

/** `lib/automaticUpdates` — the EAS Update check behind the version footer. */
export function automaticUpdatesMock(): Record<string, unknown> {
  return { checkForAppUpdate: () => mockCheckForAppUpdate() };
}

export function clipboardMock(): Record<string, unknown> {
  return { setStringAsync: (text: string) => mockSetStringAsync(text) };
}

/**
 * `Linking`, mocked at the implementation module rather than at `react-native`.
 *
 * The react-native index exposes `Linking` through a getter that reads the
 * `default` export of this module, while code importing the module path gets the
 * namespace. Both shapes are returned, backed by the same spy, so an assertion
 * holds whichever import a component happens to use.
 */
export function linkingMock(): Record<string, unknown> {
  const linking = { openURL: (url: string) => mockOpenURL(url) };
  return { __esModule: true, ...linking, default: linking };
}

/**
 * Reset everything a settings suite shares between tests.
 *
 * The settings store is module-level by design — that is what keeps the five
 * screens showing one server's state — so without this a save in one test is
 * still "saved" in the next, and a stale `settings` would render a screen whose
 * client was never asked for anything.
 */
export function resetSettingsHarness(): void {
  mockCreateVerityClient.mockReset();
  mockCheckForAppUpdate.mockReset();
  mockPush.mockReset();
  mockReplace.mockReset();
  mockBack.mockReset();
  mockDismissTo.mockReset();
  mockOpenURL.mockReset();
  mockOpenURL.mockResolvedValue(undefined);
  mockSetStringAsync.mockReset();
  mockSetStringAsync.mockResolvedValue(undefined);
  searchParams = {};
  focusCallbacks.clear();
  resetVeritySettingsStore();
}

/**
 * A neutral, fully-configured settings record, so a screen renders past its
 * loading state. No secret/key material — only paths and plain identifiers (the
 * write-only paste boxes are never populated from server state).
 *
 * Fully configured on purpose: every stored value here is non-null, which is
 * what lets the per-screen save guards assert that a patch clears nothing the
 * screen never rendered.
 */
export function makeSettings(overrides: Partial<VeritySettings> = {}): VeritySettings {
  return {
    advancedModeEnabled: false,
    gitUserName: 'test-bot',
    gitUserEmail: 'bot@example.test',
    gitSshPrivateKeyPath: '/data/keys/id',
    gitSshPublicKeyPath: '/data/keys/id.pub',
    gitKnownHostsPath: '/data/keys/known_hosts',
    gitAllowedSignersPath: '/data/keys/allowed_signers',
    gitSshPrivateKeyConfigured: true,
    gitSshPublicKeyConfigured: true,
    gitKnownHostsConfigured: true,
    gitAllowedSignersConfigured: true,
    githubAppId: '123456',
    githubAppInstallationId: '78901234',
    githubAppPrivateKeyConfigured: true,
    dopplerServiceTokenConfigured: false,
    transcribeBaseUrl: null,
    transcribeModel: null,
    transcribeBackendMode: null,
    transcribeApiKeyConfigured: false,
    // No deployment bundles a local backend any more; the server reports this
    // permanently false, so the fixture must not claim otherwise. Nothing points
    // at a remote backend either — matching the null URL/model above.
    transcribeLocalAvailable: false,
    transcribeExternalConfigured: false,
    claudeCodeOauthCredentialsConfigured: false,
    codexAuthJsonConfigured: false,
    opencodeBaseUrl: null,
    opencodeModels: null,
    opencodeApiKeyConfigured: false,
    uplinkSubscriptionKeyConfigured: false,
    uplinkInstallationId: null,
    googleDriveClientId: null,
    googleDriveAccountEmail: null,
    googleDriveConnected: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A project in whichever lifecycle state the test needs. Only the four fields
 *  `reprovisionActiveProjects` reads are meaningful. */
export function makeProject(
  id: string,
  state: 'active' | 'absent' | 'failed' = 'active',
): ProjectRecord {
  return {
    id,
    owner: 'acme',
    repo: id,
    containerName: `verity-${id}`,
    kind: 'github',
    imageRef: null,
    state,
    provisionError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as ProjectRecord;
}

export type ClientOverrides = {
  settings?: VeritySettings;
  getVeritySettings?: jest.Mock;
  updateVeritySettings?: jest.Mock;
  getSecretStatus?: jest.Mock;
  init?: jest.Mock;
  unlock?: jest.Mock;
  getSigningKey?: jest.Mock;
  generateSigningKey?: jest.Mock;
  startAgentLogin?: jest.Mock;
  getAgentLogin?: jest.Mock;
  getServerUpdates?: jest.Mock;
  requestServerUpdate?: jest.Mock;
  listProjects?: jest.Mock;
  recreateProjectContainer?: jest.Mock;
  listModels?: jest.Mock;
  listHttpMcpConnections?: jest.Mock | null;
  createHttpMcpConnection?: jest.Mock;
  deleteHttpMcpConnection?: jest.Mock;
  completeHttpMcpOAuth?: jest.Mock;
  listIntegrations?: jest.Mock;
};

/**
 * A fake client returning a fixed secret-store status.
 *
 * Only the methods a settings screen calls are implemented; every other one
 * throws, so a screen that starts talking to an endpoint nobody expected fails
 * loudly instead of silently no-op'ing behind a rendered-fine tree.
 */
export function makeClient(status: SecretStatus, opts: ClientOverrides = {}): VerityClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`unexpected client.${name} call`);
  };
  const client: Record<string, unknown> = {
    getVeritySettings:
      opts.getVeritySettings ?? jest.fn().mockResolvedValue(opts.settings ?? makeSettings()),
    getSigningKey:
      opts.getSigningKey ?? jest.fn().mockResolvedValue({ configured: false, publicKey: null }),
    generateSigningKey: opts.generateSigningKey ?? jest.fn(notImplemented('generateSigningKey')),
    getSecretStatus: opts.getSecretStatus ?? jest.fn().mockResolvedValue(status),
    getHealth: jest.fn().mockResolvedValue({ status: 'ok', version: '9.9.9' }),
    initSecretPassword: opts.init ?? jest.fn().mockResolvedValue(undefined),
    unlockSecret: opts.unlock ?? jest.fn().mockResolvedValue(undefined),
    updateVeritySettings:
      opts.updateVeritySettings ?? jest.fn(notImplemented('updateVeritySettings')),
    startAgentLogin: opts.startAgentLogin ?? jest.fn(notImplemented('startAgentLogin')),
    getAgentLogin: opts.getAgentLogin ?? jest.fn(notImplemented('getAgentLogin')),
    submitAgentLoginCode: jest.fn(notImplemented('submitAgentLoginCode')),
    disconnectAgentLogin: jest.fn(notImplemented('disconnectAgentLogin')),
    listProjects: opts.listProjects ?? jest.fn(notImplemented('listProjects')),
    recreateProjectContainer:
      opts.recreateProjectContainer ?? jest.fn(notImplemented('recreateProjectContainer')),
    // Most deployments are not Verity-managed, so the self-update panel stays
    // hidden unless a test says otherwise.
    getServerUpdates:
      opts.getServerUpdates ??
      jest.fn().mockResolvedValue({ state: 'unsupported', reason: 'not managed', operation: null }),
    requestServerUpdate: opts.requestServerUpdate ?? jest.fn(notImplemented('requestServerUpdate')),
    createHttpMcpConnection:
      opts.createHttpMcpConnection ?? jest.fn(notImplemented('createHttpMcpConnection')),
    deleteHttpMcpConnection:
      opts.deleteHttpMcpConnection ?? jest.fn(notImplemented('deleteHttpMcpConnection')),
    completeHttpMcpOAuth:
      opts.completeHttpMcpOAuth ?? jest.fn(notImplemented('completeHttpMcpOAuth')),
    listModels: opts.listModels ?? jest.fn(notImplemented('listModels')),
    listIntegrations:
      opts.listIntegrations ?? jest.fn().mockResolvedValue({ accounts: [], sources: [] }),
  };
  // `null` stands for a server too old to have the endpoint at all — the method
  // is absent, not failing, which is a case the MCP list has to tell apart.
  if (opts.listHttpMcpConnections !== null) {
    client.listHttpMcpConnections = opts.listHttpMcpConnections ?? jest.fn().mockResolvedValue([]);
  }
  return client as unknown as VerityClient;
}

/**
 * Assert that a settings patch changed only what its screen showed.
 *
 * The trap this guards is one shape of bug, not one list of keys: a screen that
 * builds its patch from the whole settings draft sends every OTHER screen's
 * fields as `null` alongside the one the operator edited, and the server takes
 * it. Since `makeSettings()` has a value for every key, "clears nothing that was
 * set" is checkable against the loaded record itself rather than against a
 * restated list that would rot the moment a field is added.
 */
export function expectPatchClearsNothing(
  patch: Record<string, unknown>,
  stored: VeritySettings = makeSettings(),
): void {
  const record = stored as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && record[key] !== null && record[key] !== undefined) {
      throw new Error(
        `patch clears ${key}, which the server holds as ${JSON.stringify(record[key])}`,
      );
    }
  }
}
