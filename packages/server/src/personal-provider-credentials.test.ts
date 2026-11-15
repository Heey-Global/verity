import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ClaudeOAuthResolutionError, type ClaudeOAuthTokenProvider } from './claudeUsage.js';
import { createPersonalProviderCredentials } from './personal-provider-credentials.js';

type Kind = 'claude' | 'codex' | 'opencode';

function memoryStore(active = new Set(['lena', 'mia'])) {
  const rows = new Map<string, { credential: string; baseUrl?: string | null }>();
  const reads: Array<() => void> = [];
  const store = {
    isActiveLocalUser: async (userId: string) => active.has(userId),
    userProviderConnections: {
      get: async (userId: string, provider: Kind) => {
        reads.shift()?.();
        const row = rows.get(`${userId}/${provider}`);
        return row === undefined ? undefined : { userId, provider, ...row };
      },
      set: async (
        userId: string,
        provider: Kind,
        value: { credential: string; baseUrl?: string },
      ) => {
        rows.set(`${userId}/${provider}`, value);
      },
      delete: async (userId: string, provider: Kind) => {
        rows.delete(`${userId}/${provider}`);
      },
      listByProvider: async (provider: Kind) =>
        [...rows.entries()]
          .filter(([key]) => key.endsWith(`/${provider}`))
          .map(([key, row]) => ({
            userId: key.split('/')[0]!,
            provider,
            credential: row.credential,
            baseUrl: row.baseUrl ?? null,
            models: null,
            updatedAt: new Date(0),
          })),
    },
  };
  return { store: store as never, rows, reads };
}

/** A refresher that reads the login and writes back a refreshed one. */
const refreshing =
  (failure?: Error) =>
  (opts: Parameters<typeof import('./claudeUsage.js').createClaudeOAuthTokenProvider>[0] = {}) =>
    (async () => {
      if (failure !== undefined) throw failure;
      const json = await opts.credentialsJsonProvider?.();
      if (json === undefined) return undefined;
      await opts.credentialsJsonUpdater?.(`refreshed:${json}`);
      return `token:${json}`;
    }) as ClaudeOAuthTokenProvider;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe('personal provider credentials', () => {
  // A refresh that started from one login must not overwrite a newer sign-in or
  // bring back a login the person signed out of.
  it("writes a refreshed Claude login back only while it is still the person's stored one", async () => {
    const { store, rows, reads } = memoryStore();
    const credentials = createPersonalProviderCredentials({
      store,
      createClaudeTokenProvider: refreshing(),
    });
    rows.set('lena/claude', { credential: 'login-1' });
    await expect(credentials.claudeAccessToken('lena')).resolves.toBe('token:login-1');
    expect(rows.get('lena/claude')?.credential).toBe('refreshed:login-1');

    // Lena signs in again while the refresh is between its read and its write.
    reads.push(
      () => undefined,
      () => rows.set('lena/claude', { credential: 'login-2' }),
    );
    await credentials.claudeAccessToken('lena');
    expect(rows.get('lena/claude')?.credential).toBe('login-2');
  });

  it('stores a Codex rotation only for the login it was made from', async () => {
    const { store, rows } = memoryStore();
    const credentials = createPersonalProviderCredentials({ store });
    rows.set('lena/codex', { credential: 'codex-1' });
    const rotation = (from: string) => ({
      userId: 'lena',
      sourceRevision: digest(from),
      updatedRevision: digest('codex-1b'),
      authJson: 'codex-1b',
    });
    await expect(credentials.persistCodexUpdate(rotation('codex-0'))).resolves.toBe(false);
    expect(rows.get('lena/codex')?.credential).toBe('codex-1');
    await expect(credentials.persistCodexUpdate(rotation('codex-1'))).resolves.toBe(true);
    expect(rows.get('lena/codex')?.credential).toBe('codex-1b');
    await credentials.persist('lena', 'codex', async () => rows.delete('lena/codex') as never);
    await expect(credentials.persistCodexUpdate(rotation('codex-1b'))).resolves.toBe(false);
    expect(rows.has('lena/codex')).toBe(false);
  });

  // The gateway section lists only active people, and a login that must be
  // signed in again is dropped rather than kept on its last token.
  it('projects only active people and drops a Claude login that needs a new sign-in', async () => {
    const { store, rows } = memoryStore(new Set(['lena']));
    rows.set('lena/opencode', { credential: 'oc-key', baseUrl: 'https://llm.example/v1' });
    rows.set('gone/opencode', { credential: 'old-key', baseUrl: 'https://llm.example/v1' });
    rows.set('lena/claude', { credential: 'login' });
    const relogin = createPersonalProviderCredentials({
      store,
      createClaudeTokenProvider: refreshing(
        new ClaudeOAuthResolutionError('relogin_required', 'invalid_grant' as never),
      ),
    });
    const projected = await relogin.people(new Map([['lena', 'stale-token']]));
    expect(projected.people).toEqual([
      { userId: 'lena', opencode: { baseUrl: 'https://llm.example/v1', apiKey: 'oc-key' } },
    ]);

    const transient = createPersonalProviderCredentials({
      store,
      createClaudeTokenProvider: refreshing(new Error('network down')),
    });
    const kept = await transient.people(new Map([['lena', 'last-token']]));
    expect(kept.people[0]?.claude).toEqual({ accessToken: 'last-token' });
  });
});
