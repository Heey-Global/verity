import { describe, expect, it, vi } from 'vitest';
import { createBrokeredSecretAliases } from './brokered-secret-aliases.js';
import { dopplerConnectionRequired } from './doppler-credential.js';

describe('brokered secret alias names per person', () => {
  // Two people's connections can see different names; a cached list for one must
  // never answer for the other, and a person without a connection sees none.
  it("lists names with each person's own connection and caches them per person", async () => {
    const tokens: Record<string, string> = { lena: 'lena-token', admin: 'admin-token' };
    const names: Record<string, string[]> = {
      'lena-token': ['LENA_KEY'],
      'admin-token': ['ADMIN_KEY'],
    };
    const listNames = vi.fn(async ({ token }: { token: Uint8Array }) => [
      ...(names[Buffer.from(token).toString()] ?? []),
    ]);
    const aliases = createBrokeredSecretAliases({
      getProjectBinding: async () => ({ dopplerProject: 'demo', dopplerConfig: 'dev' }),
      credentialFor: async (userId) => {
        const token = userId === null ? undefined : tokens[userId];
        if (token === undefined) throw dopplerConnectionRequired();
        return Buffer.from(token);
      },
      listNames,
    });
    expect(await aliases('p1', { userId: 'lena' })).toEqual(['LENA_KEY']);
    expect(await aliases('p1', { userId: 'admin' })).toEqual(['ADMIN_KEY']);
    expect(await aliases('p1', { userId: 'mia' })).toEqual([]);
    expect(await aliases('p1', { userId: 'lena' })).toEqual(['LENA_KEY']);
    expect(listNames).toHaveBeenCalledTimes(2);
  });
});
