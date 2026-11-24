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
      getProjectBindings: async () => [
        {
          id: 'default',
          connectionId: 'conn',
          isDefault: true,
          dopplerProject: 'demo',
          dopplerConfig: 'dev',
        },
      ],
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

  // ADR 0031: names of the default binding stay bare; every other binding's carry it
  // in front, each listed with the token for that binding's connection.
  it('lists each binding with its own connection, others in full', async () => {
    const credentialFor = vi.fn(
      async (_userId: string | null, _projectId: string, connectionId: string) =>
        Buffer.from(`token-${connectionId}`),
    );
    const aliases = createBrokeredSecretAliases({
      getProjectBindings: async () => [
        {
          id: 'b2',
          connectionId: 'payments',
          isDefault: false,
          dopplerProject: 'billing',
          dopplerConfig: 'dev',
        },
        {
          id: 'b1',
          connectionId: 'platform',
          isDefault: true,
          dopplerProject: 'portal',
          dopplerConfig: 'prd',
        },
      ],
      credentialFor,
      listNames: async ({ token, dopplerProject }) => {
        if (Buffer.from(token).toString() === 'token-payments' && dopplerProject === 'billing')
          return ['API_KEY'];
        if (Buffer.from(token).toString() === 'token-platform' && dopplerProject === 'portal')
          return ['API_KEY', 'DATABASE_URL'];
        throw new Error('403');
      },
    });
    expect(await aliases('p1', { userId: 'lena' })).toEqual([
      'API_KEY',
      'DATABASE_URL',
      'billing/dev/API_KEY',
    ]);
    expect(credentialFor.mock.calls.map((args) => args[2]).sort()).toEqual([
      'payments',
      'platform',
    ]);
  });
  it('refreshes cached names when the default or available bindings change', async () => {
    const platform = {
      id: 'platform',
      connectionId: 'c1',
      dopplerProject: 'portal',
      dopplerConfig: 'prod',
      isDefault: true,
    };
    const payments = {
      id: 'payments',
      connectionId: 'c2',
      dopplerProject: 'billing',
      dopplerConfig: 'dev',
      isDefault: false,
    };
    const listNames = vi.fn(async ({ dopplerProject }: { dopplerProject: string }) =>
      dopplerProject === 'portal' ? ['PORTAL_KEY'] : ['PAYMENTS_KEY'],
    );
    const getProjectBindings = vi.fn(async () => [platform, payments]);
    const aliases = createBrokeredSecretAliases({
      getProjectBindings,
      credentialFor: async () => Buffer.from('synthetic'),
      listNames,
      now: () => 0,
    });
    const actor = { userId: 'lena' };
    expect(await aliases('p1', actor)).toEqual(['PORTAL_KEY', 'billing/dev/PAYMENTS_KEY']);
    getProjectBindings.mockResolvedValue([
      { ...platform, isDefault: false },
      { ...payments, isDefault: true },
    ]);
    expect(await aliases('p1', actor)).toEqual(['PAYMENTS_KEY', 'portal/prod/PORTAL_KEY']);
    getProjectBindings.mockResolvedValue([{ ...payments, isDefault: true }]);
    expect(await aliases('p1', actor)).toEqual(['PAYMENTS_KEY']);
    getProjectBindings.mockResolvedValue([]);
    expect(await aliases('p1', actor)).toEqual([]);
    expect(listNames).toHaveBeenCalledTimes(5);
  });
});
