import { describe, expect, it, vi } from 'vitest';

import {
  createNodeRestrictedHttpTransport,
  createRestrictedHttpGetConnector,
  RestrictedHttpGetRejectedError,
  restrictedHttpGetProfileSchema,
} from './restricted-http-get-connector.js';

const profile = restrictedHttpGetProfileSchema.parse({
  id: 'legacy-read',
  projectId: 'project-1',
  origin: 'https://api.stripe.com',
  pathPrefixes: ['/v1/customers'],
  allowedQueryKeys: ['limit'],
  auth: { secretAlias: 'STRIPE_API_KEY', header: 'authorization', scheme: 'Bearer' },
});

describe('restricted HTTP GET compatibility API', () => {
  it('preserves request shape, auth header, pins, and secret zeroization', async () => {
    const secrets: Buffer[] = [];
    const transport = vi.fn().mockResolvedValue({ status: 200, body: { data: [] } });
    const connector = createRestrictedHttpGetConnector({
      profile,
      resolveSecret: async () => {
        const secret = Buffer.from('marker');
        secrets.push(secret);
        return secret;
      },
      transport,
    });
    await expect(
      connector.execute({ path: '/v1/customers', query: { limit: '5' } }),
    ).resolves.toEqual({ status: 200, body: { data: [] } });
    await expect(
      connector.execute({ path: '/v1/customers', query: { limit: '5' } }),
    ).resolves.toEqual({ status: 200, body: { data: [] } });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'api.stripe.com',
        path: '/v1/customers?limit=5',
        headers: expect.objectContaining({ authorization: 'Bearer marker' }),
      }),
    );
    expect(secrets).toHaveLength(2);
    expect(secrets.every((secret) => secret.every((byte) => byte === 0))).toBe(true);
  });

  it.each([
    { path: '/v1/charges', query: {} },
    { path: '/v1/customers', query: { expand: 'data' } },
    { path: '/v1/customers/../charges', query: {} },
  ])('preserves path and query policy rejection', async (candidate) => {
    const transport = vi.fn();
    const connector = createRestrictedHttpGetConnector({
      profile,
      resolveSecret: async () => Buffer.from('unused'),
      transport,
    });
    await expect(connector.execute(candidate)).rejects.toBeInstanceOf(
      RestrictedHttpGetRejectedError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('preserves profile validation', () => {
    for (const candidate of [
      { ...profile, origin: 'http://api.stripe.com' },
      { ...profile, origin: 'https://127.0.0.1' },
      { ...profile, pathPrefixes: ['/v1/customers', '/v1/customers'] },
      { ...profile, allowedQueryKeys: ['limit', 'limit'] },
      { ...profile, auth: { ...profile.auth, scheme: null } },
    ]) {
      expect(() => restrictedHttpGetProfileSchema.parse(candidate)).toThrow();
    }
  });

  it.each([
    '127.0.0.1',
    '10.0.0.8',
    '169.254.169.254',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:a00:8',
  ])('preserves private and metadata DNS rejection: %s', async (address) => {
    const family = address.includes(':') ? 6 : 4;
    const transport = createNodeRestrictedHttpTransport({
      lookup: vi.fn().mockResolvedValue([{ address, family }]),
    });
    await expect(
      transport({
        hostname: 'api.example.com',
        path: '/v1/read',
        headers: {},
        timeoutMs: 100,
        maxResponseBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(RestrictedHttpGetRejectedError);
  });

  it('zeroizes the secret and sanitizes transport failures', async () => {
    const secret = Buffer.from('secret-marker');
    const connector = createRestrictedHttpGetConnector({
      profile,
      resolveSecret: async () => secret,
      transport: async () => {
        throw new Error('socket contained secret-marker');
      },
    });
    await expect(connector.execute({ path: '/v1/customers', query: {} })).rejects.toEqual(
      new RestrictedHttpGetRejectedError(),
    );
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  it('sanitizes secret resolver and malformed successful-response failures', async () => {
    const resolverFailure = createRestrictedHttpGetConnector({
      profile,
      resolveSecret: async () => {
        throw new Error('Doppler project and token details');
      },
      transport: vi.fn(),
    });
    await expect(resolverFailure.execute({ path: '/v1/customers', query: {} })).rejects.toEqual(
      new RestrictedHttpGetRejectedError(),
    );

    const malformedResponse = createRestrictedHttpGetConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      transport: async () => ({ status: 200, body: 'not-json-object' }),
    });
    await expect(malformedResponse.execute({ path: '/v1/customers', query: {} })).rejects.toEqual(
      new RestrictedHttpGetRejectedError(),
    );
  });
});
