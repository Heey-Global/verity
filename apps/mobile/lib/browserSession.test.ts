import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { createPairingUri } from './pairing';
import {
  authenticateBrowser,
  browserFetch,
  clearBrowserSession,
  getBrowserSession,
  logoutBrowser,
  pairBrowser,
  refreshBrowserSession,
} from './browserSession';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const identityKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const serverId = 'srv_abcdefghijklmnop';
const session = {
  authenticated: true,
  tokenId: 'browser-device',
  serverId,
  identityKey,
  tlsPin: `sha256-${'a'.repeat(43)}`,
};
const calls: { path: string; init?: RequestInit }[] = [];
let corruptSignature = false;
let sessionStatus = 200;

beforeEach(() => {
  clearBrowserSession();
  calls.length = 0;
  corruptSignature = false;
  sessionStatus = 200;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://core.test' } },
  });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, init });
    if (url.pathname === '/pair/identity') {
      const challenge = url.searchParams.get('challenge');
      const signature = sign(
        null,
        Buffer.from(
          `verity.device-pairing.v1\0${serverId}\0${corruptSignature ? 'other' : challenge}`,
        ),
        privateKey,
      ).toString('base64url');
      return new Response(JSON.stringify({ serverId, identityKey, signature }));
    }
    if (url.pathname === '/pair/redeem')
      return new Response(
        JSON.stringify({
          bootstrapToken: 'bootstrap-capability',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
    if (url.pathname === '/auth/session')
      return new Response(JSON.stringify(sessionStatus === 200 ? session : {}), {
        status: sessionStatus,
      });
    if (url.pathname === '/auth/logout') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ tokenId: session.tokenId }));
  }) as typeof fetch;
});
function link(kind: 'installer' | 'device'): string {
  return createPairingUri({
    version: 1,
    kind,
    serverId,
    identityKey,
    tlsPin: session.tlsPin!,
    pairingCode: 'p'.repeat(32),
    suggestedUrl: 'https://other-lan-address.test',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
}

test('verifies installer identity before redeeming and keeps the bootstrap out of ordinary requests', async () => {
  expect(await pairBrowser(link('installer'))).toBe('password');
  await authenticateBrowser('a-long-master-password', true);
  expect(getBrowserSession()?.tokenId).toBe(session.tokenId);
  const init = calls.find((call) => call.path === '/secret/init/browser')!.init!;
  expect(init.headers).toEqual({
    'content-type': 'application/json',
    'x-verity-pairing': 'bootstrap-capability',
  });
  expect(init.credentials).toBe('include');
  expect(calls.find((call) => call.path === '/auth/session')!.init!.headers).toBeUndefined();
});

test('rejects a relayed identity with an invalid signature before submitting the pairing secret', async () => {
  corruptSignature = true;
  await expect(pairBrowser(link('installer'))).rejects.toThrow('signature');
  expect(calls.map((call) => call.path)).toEqual(['/pair/identity']);
});

test('device invitation establishes a cookie session without redeeming an installer bootstrap', async () => {
  expect(await pairBrowser(link('device'))).toBe('authenticated');
  expect(calls.map((call) => call.path)).toEqual([
    '/pair/identity',
    '/pair/enroll/browser',
    '/auth/session',
  ]);
  expect(JSON.parse(calls[1].init!.body as string)).toMatchObject({
    code: 'p'.repeat(32),
    deviceLabel: 'Web browser',
  });
});

test('logout clears the session only after the server revokes it', async () => {
  await refreshBrowserSession();
  await logoutBrowser();
  expect(getBrowserSession()).toBeNull();
  expect(calls[1]).toMatchObject({
    path: '/auth/logout',
    init: { method: 'POST', credentials: 'include' },
  });
});

test('a cookie-only unauthorized response clears the authenticated state', async () => {
  await refreshBrowserSession();
  sessionStatus = 401;
  await browserFetch('https://core.test/auth/session');
  expect(getBrowserSession()).toBeNull();
});

test('browser-only invitations accept the opaque code created by the web Devices screen', async () => {
  expect(await pairBrowser('q'.repeat(32))).toBe('authenticated');
  expect(calls.map((call) => call.path)).toEqual(['/pair/enroll/browser', '/auth/session']);
});

test('a reloaded unlock screen restores its cookie session before sending the password', async () => {
  // Reload drops JavaScript state but must not discard an existing paired browser.
  jest.resetModules();
  const reloaded = jest.requireActual<typeof import('./browserSession')>('./browserSession');
  await reloaded.authenticateBrowser('a-long-master-password', false);
  expect(calls.map((call) => call.path)).toEqual([
    '/auth/session',
    '/secret/unlock/browser',
    '/auth/session',
  ]);
  expect(calls[1].init).toMatchObject({
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  });
  expect(calls[1].init!.headers).not.toHaveProperty('x-verity-pairing');
});

test('a reloaded unlock screen with a revoked cookie does not submit the password', async () => {
  jest.resetModules();
  const reloaded = jest.requireActual<typeof import('./browserSession')>('./browserSession');
  sessionStatus = 401;
  await expect(reloaded.authenticateBrowser('a-long-master-password', false)).rejects.toThrow(
    'Pairing expired',
  );
  expect(calls.map((call) => call.path)).toEqual(['/auth/session']);
});
