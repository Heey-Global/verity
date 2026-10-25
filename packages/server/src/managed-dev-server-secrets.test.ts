import { describe, expect, it, vi } from 'vitest';
import { createManagedDevServerSecretResolver } from './managed-dev-server-secrets.js';

const bindings = [
  { secretAlias: 'ATTENDEE_API_KEY', env: 'API_KEY' },
  { secretAlias: 'EXPO_TOKEN', env: 'OTHER_KEY' },
];

describe('managed dev server secret resolution', () => {
  it('resolves fresh project-scoped values for every start and zeroizes consumed buffers', async () => {
    const buffers: Uint8Array[] = [];
    let generation = 0;
    const resolveSecret = vi.fn(async () => {
      const value = new TextEncoder().encode(`synthetic-key-${generation++}`);
      buffers.push(value);
      return value;
    });
    const resolve = createManagedDevServerSecretResolver({
      getProjectBinding: async () => ({ dopplerProject: 'demo', dopplerConfig: 'dev' }),
      resolveSecret,
    });
    expect(await resolve('p1', bindings)).toEqual([
      { env: 'API_KEY', value: 'synthetic-key-0' },
      { env: 'OTHER_KEY', value: 'synthetic-key-1' },
    ]);
    expect(await resolve('p1', bindings)).toEqual([
      { env: 'API_KEY', value: 'synthetic-key-2' },
      { env: 'OTHER_KEY', value: 'synthetic-key-3' },
    ]);
    expect(resolveSecret.mock.calls).toHaveLength(4);
    expect(resolveSecret).toHaveBeenCalledWith({
      projectId: 'p1',
      dopplerProject: 'demo',
      dopplerConfig: 'dev',
      secretName: 'ATTENDEE_API_KEY',
    });
    expect(buffers.every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  it('returns no partial secret set and hides failures when a later alias cannot resolve', async () => {
    const first = new TextEncoder().encode('synthetic-sensitive-value');
    let count = 0;
    const resolve = createManagedDevServerSecretResolver({
      getProjectBinding: async () => ({ dopplerProject: 'demo', dopplerConfig: 'dev' }),
      resolveSecret: async () => {
        if (count++ === 0) return first;
        throw new Error('synthetic-sensitive-value');
      },
    });
    await expect(resolve('p1', bindings)).rejects.toThrow(
      'Could not resolve managed server secrets',
    );
    expect(first.every((byte) => byte === 0)).toBe(true);
  });

  it.each([new Uint8Array(), new Uint8Array([0]), new Uint8Array([255])])(
    'refuses values unsuitable for environment delivery',
    async (raw) => {
      const resolve = createManagedDevServerSecretResolver({
        getProjectBinding: async () => ({ dopplerProject: 'demo', dopplerConfig: 'dev' }),
        resolveSecret: async () => raw,
      });
      await expect(resolve('p1', bindings.slice(0, 1))).rejects.toThrow('Could not resolve');
      expect(raw.every((byte) => byte === 0)).toBe(true);
    },
  );
});
