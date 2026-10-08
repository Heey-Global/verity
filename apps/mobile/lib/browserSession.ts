import { parsePairingUri } from './pairing';

export interface BrowserSession {
  authenticated: true;
  tokenId: string;
  serverId: string;
  identityKey: string;
  tlsPin?: string;
}
let session: BrowserSession | null = null;
let bootstrap: { serverId: string; code: string; token: string; expiresAt: number } | null = null;
let enrollment: { code: string; enrollmentId: string } | null = null;
export function getBrowserSession(): BrowserSession | null {
  return session;
}
const listeners = new Set<() => void>();
export function subscribeBrowserSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function clearBrowserSession(): void {
  const authenticated = session !== null;
  session = null;
  if (authenticated) for (const listener of listeners) listener();
}
export const browserFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, credentials: 'include' });
  if (response.status === 401) clearBrowserSession();
  return response;
};
async function request(path: string, body?: unknown, pairingBootstrap?: string): Promise<unknown> {
  const response = await browserFetch(`${window.location.origin}${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(pairingBootstrap ? { 'x-verity-pairing': pairingBootstrap } : {}),
          },
          body: JSON.stringify(body),
        }),
  });
  if (response.status === 204) return {};
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof result.error === 'string'
        ? result.error
        : typeof result.message === 'string'
          ? result.message
          : `Request failed (${response.status}).`,
    );
  return result;
}
export async function refreshBrowserSession(): Promise<BrowserSession | null> {
  const response = await browserFetch(`${window.location.origin}/auth/session`);
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Could not check browser session.');
  session = (await response.json()) as BrowserSession;
  return session;
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
}
function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
async function enrollBrowserInvitation(code: string): Promise<void> {
  if (enrollment?.code !== code) enrollment = { code, enrollmentId: nonce() };
  await request('/pair/enroll/browser', {
    code,
    enrollmentId: enrollment.enrollmentId,
    deviceLabel: 'Web browser',
  });
  if (!(await refreshBrowserSession()))
    throw new Error('The browser session could not be established.');
}

/** Signed identity checks bind the pasted code to this Core; they cannot replace trusted TLS. */
export async function pairBrowser(raw: string): Promise<'password' | 'authenticated'> {
  const invitationCode = raw.trim();
  if (/^[A-Za-z0-9_-]{32,128}$/.test(invitationCode)) {
    await enrollBrowserInvitation(invitationCode);
    return 'authenticated';
  }
  const payload = parsePairingUri(raw);
  const challenge = nonce();
  const identity = (await request(`/pair/identity?challenge=${challenge}`)) as {
    serverId: string;
    identityKey: string;
    signature: string;
  };
  if (identity.serverId !== payload.serverId || identity.identityKey !== payload.identityKey)
    throw new Error('The server identity does not match the pairing code.');
  const key = await crypto.subtle.importKey(
    'spki',
    decode(payload.identityKey),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'Ed25519',
    key,
    decode(identity.signature),
    new TextEncoder().encode(`verity.device-pairing.v1\0${identity.serverId}\0${challenge}`),
  );
  if (!valid) throw new Error('The server identity signature is invalid.');
  if (payload.kind === 'device') {
    await enrollBrowserInvitation(payload.pairingCode);
    return 'authenticated';
  }
  if (
    bootstrap === null ||
    bootstrap.serverId !== payload.serverId ||
    bootstrap.code !== payload.pairingCode ||
    bootstrap.expiresAt <= Date.now()
  ) {
    const result = (await request('/pair/redeem', { code: payload.pairingCode })) as {
      bootstrapToken: string;
      expiresAt: string;
    };
    const expiresAt = Date.parse(result.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
      throw new Error('The pairing session expired.');
    bootstrap = {
      serverId: payload.serverId,
      code: payload.pairingCode,
      token: result.bootstrapToken,
      expiresAt,
    };
  }
  return 'password';
}
export async function authenticateBrowser(password: string, initialize: boolean): Promise<void> {
  if ((bootstrap === null || bootstrap.expiresAt <= Date.now()) && session === null) {
    // The HttpOnly cookie survives a reload even though JavaScript session state does not.
    if (!(await refreshBrowserSession()))
      throw new Error('Pairing expired. Paste a new pairing link.');
  }
  await request(
    initialize ? '/secret/init/browser' : '/secret/unlock/browser',
    { password, deviceLabel: 'Web browser' },
    bootstrap?.token,
  );
  bootstrap = null;
  if (!(await refreshBrowserSession()))
    throw new Error('The browser session could not be established.');
}
export async function logoutBrowser(): Promise<void> {
  await request('/auth/logout', {});
  clearBrowserSession();
}
