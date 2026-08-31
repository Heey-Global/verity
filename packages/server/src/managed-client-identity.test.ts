import { describe, expect, it } from 'vitest';

import {
  signManagedClientIdentity,
  verifyManagedClientIdentity,
} from './managed-client-identity.js';

describe('managed client identity', () => {
  const secret = Buffer.alloc(32, 7);
  const request = { method: 'POST', url: '/secret/unlock', now: 1_000_000 };

  it('round-trips the gateway-authenticated socket peer', () => {
    const value = signManagedClientIdentity(secret, { address: '192.0.2.4', ...request });
    expect(verifyManagedClientIdentity(secret, value, request)).toBe('192.0.2.4');
  });

  it('rejects spoofed, replayed, and request-transplanted identities', () => {
    const value = signManagedClientIdentity(secret, { address: '192.0.2.4', ...request });
    expect(verifyManagedClientIdentity(Buffer.alloc(32, 8), value, request)).toBeUndefined();
    expect(
      verifyManagedClientIdentity(secret, value, { ...request, url: '/settings' }),
    ).toBeUndefined();
    expect(
      verifyManagedClientIdentity(secret, value, { ...request, now: request.now + 30_001 }),
    ).toBeUndefined();
  });
});
