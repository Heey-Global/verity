import type { HttpMcpConnection, VerityClient } from '@verity/mobile';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform } from 'react-native';
import { isDemoMode } from './demoMode';

const NATIVE_CALLBACK = 'https://verity.build/mcp/oauth/callback';
const CALLBACK_PATH = '/app/mcp/oauth/callback';
const CALLBACK_MESSAGE = 'verity:mcp-oauth-callback';

type OAuthResult = { kind: 'success'; code: string; state: string } | { kind: 'cancelled' };
let pending: { state: string; accept: (url: URL) => void } | undefined;
let signingIn = false;
let recentCallback: { state: string; expiresAt: number } | undefined;

export function mcpOAuthCallbackUri(): string {
  return Platform.OS === 'web' && typeof window !== 'undefined'
    ? `${window.location.origin}${CALLBACK_PATH}`
    : NATIVE_CALLBACK;
}

function nativeScheme(): string {
  const schemes = Constants.expoConfig?.scheme;
  return (Array.isArray(schemes) ? schemes : [schemes]).includes('verity-staging')
    ? 'verity-staging'
    : 'verity';
}

function isCallback(url: URL): boolean {
  if (Platform.OS === 'web')
    return url.origin === window.location.origin && url.pathname === CALLBACK_PATH;
  return (
    (url.origin === 'https://verity.build' && url.pathname === '/mcp/oauth/callback') ||
    (url.protocol === `${nativeScheme()}:` &&
      url.hostname === 'mcp' &&
      url.pathname === '/oauth/callback')
  );
}

/** Shared by the app route, native link listener and browser-session result. */
export function receiveMcpOAuthCallback(value: string): boolean {
  try {
    const url = new URL(value);
    const state = url.searchParams.get('state');
    if (!isCallback(url) || state === null) return false;
    // Linking can resolve the browser promise before Expo mounts the callback
    // route. Acknowledge that route without redeeming the grant a second time.
    if (pending === undefined)
      return recentCallback?.state === state && recentCallback.expiresAt > Date.now();
    if (state !== pending.state) return false;
    recentCallback = { state, expiresAt: Date.now() + 30_000 };
    pending.accept(url);
    return true;
  } catch {
    return false;
  }
}

/** Only the opener on this exact origin may receive the popup result. */
export function completeMcpOAuthPopup(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.opener) return false;
  const url = new URL(window.location.href);
  if (!isCallback(url)) return false;
  if (
    !url.searchParams.get('state') ||
    (!url.searchParams.has('code') && !url.searchParams.has('error'))
  )
    return false;
  window.opener.postMessage({ type: CALLBACK_MESSAGE, url: url.href }, window.location.origin);
  window.history.replaceState(null, '', url.pathname);
  window.close();
  return true;
}

export async function runMcpOAuth(
  connection: HttpMcpConnection,
  client: VerityClient,
): Promise<OAuthResult> {
  if (isDemoMode())
    throw new Error('MCP sign-in requires your own Verity server. Exit the demo to connect.');
  if (signingIn) throw new Error('An MCP sign-in is already in progress.');
  signingIn = true;
  recentCallback = undefined;
  const server = client.liveBaseUrl();
  // Open synchronously in the click handler, before the API request consumes browser activation.
  let popup: Window | null = null;
  let state: string | undefined;
  let succeeded = false;
  let cleanup = (): void => undefined;
  try {
    popup =
      Platform.OS === 'web'
        ? window.open('about:blank', 'verity-mcp-oauth', 'popup,width=600,height=750')
        : null;
    if (Platform.OS === 'web' && popup === null)
      throw new Error('Allow popups to connect this MCP account.');
    const flow = await client.startHttpMcpOAuth(
      connection.id,
      Platform.OS === 'web'
        ? 'web'
        : nativeScheme() === 'verity-staging'
          ? 'native-staging'
          : 'native',
    );
    state = flow.state;
    if (flow.redirectUri !== mcpOAuthCallbackUri() || server !== client.liveBaseUrl())
      throw new Error('The Verity address changed. Start OAuth again.');
    const result = await new Promise<OAuthResult>((resolve, reject) => {
      let settled = false;
      const settle = (value: OAuthResult | Error) => {
        if (settled) return;
        settled = true;
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      pending = {
        state: flow.state,
        accept: (url) => {
          if (server !== client.liveBaseUrl())
            return settle(new Error('The Verity server changed. Start OAuth again.'));
          if (url.searchParams.has('error'))
            return settle(new Error('MCP authorization was declined. Connect OAuth to try again.'));
          const code = url.searchParams.get('code');
          settle(
            code
              ? { kind: 'success', code, state: flow.state }
              : new Error('The OAuth callback is incomplete. Connect OAuth again.'),
          );
        },
      };
      const timeout = setTimeout(
        () => settle(new Error('MCP sign-in expired. Connect OAuth again.')),
        Math.max(1, Math.min(flow.expiresAt - Date.now(), 10 * 60_000)),
      );
      const subscription = Linking.addEventListener('url', ({ url }) => {
        receiveMcpOAuthCallback(url);
      });
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin || event.source !== popup) return;
        const data = event.data as { type?: unknown; url?: unknown } | null;
        if (data?.type === CALLBACK_MESSAGE && typeof data.url === 'string')
          receiveMcpOAuthCallback(data.url);
      };
      let closed: ReturnType<typeof setInterval> | undefined;
      if (Platform.OS === 'web') {
        window.addEventListener('message', onMessage);
        closed = setInterval(() => {
          if (popup?.closed) settle({ kind: 'cancelled' });
        }, 500);
      }
      cleanup = () => {
        clearTimeout(timeout);
        if (closed !== undefined) clearInterval(closed);
        subscription.remove();
        if (Platform.OS === 'web') window.removeEventListener('message', onMessage);
      };
      if (popup) popup.location.replace(flow.authorizationUrl);
      else
        void WebBrowser.openAuthSessionAsync(
          flow.authorizationUrl,
          Platform.OS === 'ios' ? flow.redirectUri : `${nativeScheme()}://mcp/oauth/callback`,
          { preferEphemeralSession: false, preferUniversalLinks: Platform.OS === 'ios' },
        )
          .then((response) => {
            if (response.type === 'success') {
              if (!receiveMcpOAuthCallback(response.url))
                settle(
                  new Error('The OAuth callback did not match this sign-in. Connect OAuth again.'),
                );
            } else settle({ kind: 'cancelled' });
          })
          .catch(() => settle(new Error('The sign-in browser could not be opened. Try again.')));
    });
    succeeded = result.kind === 'success';
    return result;
  } finally {
    cleanup();
    pending = undefined;
    signingIn = false;
    popup?.close();
    if (Platform.OS !== 'web') {
      try {
        WebBrowser.dismissAuthSession();
      } catch {
        /* The session may already be closed. */
      }
    }
    if (!succeeded && state !== undefined && server === client.liveBaseUrl())
      await client.cancelHttpMcpOAuth(connection.id, state).catch(() => undefined);
  }
}
