import type { EventStore, GoogleAccount } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleAccountAccessToken } from './google-account-token.js';

describe('account-specific Google token cache', () => {
  it('refuses ambiguity, isolates caches, refreshes scope upgrades and rejects removed accounts', async () => {
    const accounts: GoogleAccount[] = ['one', 'two'].map((id) => ({
      id,
      email: `${id}@example.com`,
      subject: null,
      displayName: null,
      clientId: 'client',
      scopes: [],
      credentialVersion: 1,
    }));
    const store = {
      googleAccounts: {
        list: async () => accounts,
        credentials: async (id: string) =>
          accounts.some((a) => a.id === id)
            ? { clientId: 'client', refreshToken: `refresh-${id}`, credentialVersion: 1 }
            : undefined,
      },
    } as unknown as Pick<EventStore, 'googleAccounts'>;
    const fetchToken = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: `access-${typeof init?.body === 'string' ? init.body : ''}`,
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );
    const provider = createGoogleAccountAccessToken(store, { fetch: fetchToken });
    expect(await provider()).toBeUndefined();
    const one = await provider('one');
    const two = await provider('two');
    expect(one).not.toBe(two);
    expect(await provider('one')).toBe(one);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    accounts[0]!.credentialVersion++;
    await provider('one');
    expect(fetchToken).toHaveBeenCalledTimes(3);
    accounts.shift();
    expect(await provider('one')).toBeUndefined();
    expect(await provider()).toBe(two);
  });
});
