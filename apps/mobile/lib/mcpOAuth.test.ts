import type { HttpMcpConnection, VerityClient } from '@verity/mobile';
import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { isDemoMode } from './demoMode';
import {
  completeMcpOAuthPopup,
  mcpOAuthCallbackUri,
  receiveMcpOAuthCallback,
  runMcpOAuth,
} from './mcpOAuth';

jest.mock('./demoMode', () => ({ isDemoMode: jest.fn().mockReturnValue(false) }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { scheme: ['verity'] } },
}));
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn(),
  dismissAuthSession: jest.fn(),
  WebBrowserResultType: { CANCEL: 'cancel' },
}));

const connection = { id: 'tools' } as HttpMcpConnection;
const flow = {
  state: 'state',
  redirectUri: 'https://verity.build/mcp/oauth/callback',
  authorizationUrl: 'https://identity.example/authorize',
  expiresAt: Date.now() + 600_000,
};
function client() {
  return {
    liveBaseUrl: jest.fn(() => 'http://192.168.0.8'),
    startHttpMcpOAuth: jest.fn().mockResolvedValue(flow),
    cancelHttpMcpOAuth: jest.fn().mockResolvedValue(undefined),
  } as unknown as VerityClient;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const originalPlatform = Platform.OS;
afterEach(() => {
  jest.clearAllMocks();
  jest.mocked(isDemoMode).mockReturnValue(false);
  Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
});

it('does not launch OAuth in the local demo', async () => {
  jest.mocked(isDemoMode).mockReturnValue(true);
  const api = client();
  await expect(runMcpOAuth(connection, api)).rejects.toThrow('Exit the demo');
  expect(api.startHttpMcpOAuth).not.toHaveBeenCalled();
});
it('uses the native HTTPS callback with universal-link matching and consumes a matching result', async () => {
  jest
    .mocked(WebBrowser.openAuthSessionAsync)
    .mockResolvedValue({ type: 'success', url: `${flow.redirectUri}?state=state&code=code` });
  await expect(runMcpOAuth(connection, client())).resolves.toEqual({
    kind: 'success',
    code: 'code',
    state: 'state',
  });
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
    flow.authorizationUrl,
    flow.redirectUri,
    { preferEphemeralSession: false, preferUniversalLinks: true },
  );
  expect(receiveMcpOAuthCallback(`${flow.redirectUri}?state=state&code=again`)).toBe(true);
});
it('rejects a wrong state without returning a code', async () => {
  const api = client();
  jest
    .mocked(WebBrowser.openAuthSessionAsync)
    .mockResolvedValue({ type: 'success', url: `${flow.redirectUri}?state=other&code=code` });
  await expect(runMcpOAuth(connection, api)).rejects.toThrow(/did not match/u);
  expect(api.cancelHttpMcpOAuth).toHaveBeenCalledWith(connection.id, 'state');
});
it('handles an app-scheme callback while the browser is open and ignores duplicates', async () => {
  const browser = deferred<WebBrowser.WebBrowserAuthSessionResult>();
  jest.mocked(WebBrowser.openAuthSessionAsync).mockReturnValue(browser.promise);
  const subscription = jest.spyOn(Linking, 'addEventListener');
  const result = runMcpOAuth(connection, client());
  await Promise.resolve();
  expect(receiveMcpOAuthCallback('verity://mcp/oauth/callback?state=state&code=scheme')).toBe(true);
  expect(
    receiveMcpOAuthCallback('https://evil.example/mcp/oauth/callback?state=state&code=bad'),
  ).toBe(false);
  await expect(result).resolves.toMatchObject({ code: 'scheme' });
  expect(subscription).toHaveBeenCalled();
  // The route mounts after the native listener has already resolved the flow.
  expect(receiveMcpOAuthCallback(`${flow.redirectUri}?state=state&code=scheme`)).toBe(true);
  browser.resolve({ type: WebBrowser.WebBrowserResultType.CANCEL });
});
it('treats cancellation as cancellation and invalidates the pending server flow', async () => {
  const api = client();
  jest
    .mocked(WebBrowser.openAuthSessionAsync)
    .mockResolvedValue({ type: WebBrowser.WebBrowserResultType.CANCEL });
  await expect(runMcpOAuth(connection, api)).resolves.toEqual({ kind: 'cancelled' });
  expect(api.cancelHttpMcpOAuth).toHaveBeenCalledWith('tools', 'state');
});
it('rejects declined and incomplete callbacks', async () => {
  for (const query of ['error=access_denied', '']) {
    jest
      .mocked(WebBrowser.openAuthSessionAsync)
      .mockResolvedValue({ type: 'success', url: `${flow.redirectUri}?state=state&${query}` });
    await expect(runMcpOAuth(connection, client())).rejects.toThrow();
  }
});
it('does not accept a callback after the configured server changed', async () => {
  const api = client();
  jest.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async () => {
    jest.mocked(api.liveBaseUrl).mockReturnValue('https://other.example');
    return { type: 'success', url: `${flow.redirectUri}?state=state&code=code` };
  });
  await expect(runMcpOAuth(connection, api)).rejects.toThrow(/server changed/u);
});
it('reports expired flows and cleans up the browser listener', async () => {
  jest.useFakeTimers();
  try {
    jest.mocked(WebBrowser.openAuthSessionAsync).mockReturnValue(new Promise(() => undefined));
    const result = runMcpOAuth(connection, client());
    const rejection = expect(result).rejects.toThrow(/expired/u);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(600_001);
    await rejection;
  } finally {
    jest.useRealTimers();
  }
});

it('opens the web popup before requesting the authorization URL and validates source, origin and state', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
  const origin = 'https://host.tail.example';
  const popup = { location: { replace: jest.fn() }, close: jest.fn(), closed: false };
  let onMessage: ((event: MessageEvent) => void) | undefined;
  const fakeWindow = {
    location: { origin, href: `${origin}/app/settings` },
    open: jest.fn(() => popup),
    addEventListener: jest.fn((_event, handler: (event: MessageEvent) => void) => {
      onMessage = handler;
    }),
    removeEventListener: jest.fn(),
  };
  const previousWindow = global.window;
  Object.defineProperty(global, 'window', { value: fakeWindow, configurable: true });
  try {
    const api = client();
    jest.mocked(api.startHttpMcpOAuth).mockImplementation(async () => {
      expect(fakeWindow.open).toHaveBeenCalledTimes(1);
      return { ...flow, redirectUri: `${origin}/app/mcp/oauth/callback` };
    });
    const result = runMcpOAuth(connection, api);
    await Promise.resolve();
    expect(mcpOAuthCallbackUri()).toBe(`${origin}/app/mcp/oauth/callback`);
    const data = {
      type: 'verity:mcp-oauth-callback',
      url: `${mcpOAuthCallbackUri()}?state=state&code=web`,
    };
    onMessage!({ source: popup, origin: 'https://evil.example', data } as unknown as MessageEvent);
    onMessage!({ source: {}, origin, data } as unknown as MessageEvent);
    onMessage!({
      source: popup,
      origin,
      data: { ...data, url: `${mcpOAuthCallbackUri()}?state=wrong&code=bad` },
    } as unknown as MessageEvent);
    expect(api.cancelHttpMcpOAuth).not.toHaveBeenCalled();
    onMessage!({ source: popup, origin, data } as unknown as MessageEvent);
    await expect(result).resolves.toMatchObject({ code: 'web' });
    expect(fakeWindow.removeEventListener).toHaveBeenCalled();
  } finally {
    Object.defineProperty(global, 'window', { value: previousWindow, configurable: true });
  }
});
it('posts popup results only to the same origin and clears the callback from browser history', () => {
  Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
  const previousWindow = global.window;
  const origin = 'https://host.example';
  const url = `${origin}/app/mcp/oauth/callback?state=state&code=code`;
  const fakeWindow = {
    location: { origin, href: url },
    opener: { postMessage: jest.fn() },
    history: { replaceState: jest.fn() },
    close: jest.fn(),
  };
  Object.defineProperty(global, 'window', { value: fakeWindow, configurable: true });
  try {
    expect(completeMcpOAuthPopup()).toBe(true);
    expect(fakeWindow.opener.postMessage).toHaveBeenCalledWith(
      { type: 'verity:mcp-oauth-callback', url },
      origin,
    );
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/app/mcp/oauth/callback',
    );
  } finally {
    Object.defineProperty(global, 'window', { value: previousWindow, configurable: true });
  }
});
