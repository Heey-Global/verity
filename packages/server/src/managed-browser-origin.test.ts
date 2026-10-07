import { describe, expect, it } from 'vitest';
import { signManagedClientIdentity } from './managed-client-identity.js';
import { signManagedBrowserOrigin, verifyManagedBrowserOrigin } from './managed-browser-origin.js';

describe('managed browser origin', () => {
  const secret = Buffer.alloc(32, 7);
  const request = { method: 'POST', url: '/secret/init/browser', now: 1_000_000 };
  it('authenticates the public origin independently of the backend Host', () => {
    const signed = signManagedBrowserOrigin(secret, {
      ...request,
      origin: 'https://core.local:9443',
    });
    expect(verifyManagedBrowserOrigin(secret, signed, request)).toBe('https://core.local:9443');
  });
  it('rejects caller metadata, transplanted client identity, altered requests, and expired metadata', () => {
    const signed = signManagedBrowserOrigin(secret, { ...request, origin: 'https://core.local' });
    expect(verifyManagedBrowserOrigin(secret, 'https://evil.local', request)).toBeUndefined();
    expect(
      verifyManagedBrowserOrigin(
        secret,
        signManagedClientIdentity(secret, { ...request, address: 'https://evil.local' }),
        request,
      ),
    ).toBeUndefined();
    expect(
      verifyManagedBrowserOrigin(secret, signed, { ...request, url: '/auth/logout' }),
    ).toBeUndefined();
    expect(
      verifyManagedBrowserOrigin(secret, signed, { ...request, now: request.now + 30_001 }),
    ).toBeUndefined();
    expect(
      signManagedBrowserOrigin(secret, { ...request, origin: 'https://core.local/path' }),
    ).toBeUndefined();
  });
});
