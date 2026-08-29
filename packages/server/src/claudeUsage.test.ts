import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createClaudeOAuthTokenProvider,
  createClaudeUsageService,
  parseClaudeUsage,
  resolveClaudeOAuthToken,
  type FetchLike,
} from './claudeUsage.js';

const FIVE_HOUR_ISO = '2026-04-11T07:00:00.000+00:00';
const SEVEN_DAY_ISO = '2026-04-17T00:59:59.000+00:00';
const FIVE_HOUR_EPOCH = Math.floor(Date.parse(FIVE_HOUR_ISO) / 1000);
const SEVEN_DAY_EPOCH = Math.floor(Date.parse(SEVEN_DAY_ISO) / 1000);

const USAGE_BODY = {
  five_hour: { utilization: 33, resets_at: FIVE_HOUR_ISO },
  seven_day: { utilization: 100, resets_at: SEVEN_DAY_ISO },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 1, resets_at: SEVEN_DAY_ISO },
  extra_usage: { is_enabled: false },
};

/** A fetch stub that returns `body` with 200, counting calls. */
function okFetch(body: unknown): { fetch: FetchLike; calls: () => number } {
  let calls = 0;
  const fetch: FetchLike = () => {
    calls += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { fetch, calls: () => calls };
}

describe('parseClaudeUsage', () => {
  it('maps five_hour → five-hour and seven_day → weekly with percent + epoch reset', () => {
    expect(parseClaudeUsage(USAGE_BODY)).toEqual([
      {
        status: 'allowed',
        resetsAt: FIVE_HOUR_EPOCH,
        window: 'five_hour',
        usedPercent: 33,
        providerLabel: 'Claude',
      },
      {
        status: 'rejected', // 100% → blocked
        resetsAt: SEVEN_DAY_EPOCH,
        window: 'weekly',
        usedPercent: 100,
        providerLabel: 'Claude',
      },
    ]);
  });

  it('skips absent, null, or malformed windows', () => {
    expect(parseClaudeUsage({ five_hour: null, seven_day: undefined })).toEqual([]);
    expect(parseClaudeUsage({ five_hour: { utilization: 5, resets_at: 'not-a-date' } })).toEqual(
      [],
    );
    expect(parseClaudeUsage({ five_hour: { utilization: 5 } })).toEqual([]);
  });

  it('returns [] for non-object input', () => {
    expect(parseClaudeUsage(null)).toEqual([]);
    expect(parseClaudeUsage('nope')).toEqual([]);
  });
});

describe('resolveClaudeOAuthToken', () => {
  it('reads Claude credentials file accessToken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-claude-usage-'));
    const credentials = join(dir, '.credentials.json');
    writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }));
    expect(resolveClaudeOAuthToken(credentials)).toBe('file-token');
  });

  it('returns undefined for missing or malformed credentials', () => {
    expect(resolveClaudeOAuthToken('/does/not/exist')).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'verity-claude-usage-'));
    const credentials = join(dir, '.credentials.json');
    writeFileSync(credentials, JSON.stringify({ claudeAiOauth: {} }));
    expect(resolveClaudeOAuthToken(credentials)).toBeUndefined();
  });
});

describe('createClaudeOAuthTokenProvider', () => {
  it('returns a non-expired credentials file token without refreshing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-claude-usage-'));
    const credentials = join(dir, '.credentials.json');
    writeFileSync(
      credentials,
      JSON.stringify({ claudeAiOauth: { accessToken: 'file-token', expiresAt: 100_000 } }),
    );
    const fetch: FetchLike = () => {
      throw new Error('unexpected refresh');
    };
    const provider = createClaudeOAuthTokenProvider({
      env: {},
      credentialsPath: credentials,
      fetch,
      now: () => 1_000,
    });

    await expect(provider()).resolves.toBe('file-token');
  });

  it('refreshes expired credentials and persists the rotated tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-claude-usage-'));
    const credentials = join(dir, '.credentials.json');
    writeFileSync(
      credentials,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: 1_000,
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
        },
      }),
    );
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetch: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'new-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
      });
    };
    const provider = createClaudeOAuthTokenProvider({
      env: {},
      credentialsPath: credentials,
      fetch,
      now: () => 10_000,
      userAgent: 'claude-code/test',
    });

    await expect(provider()).resolves.toBe('new-token');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      scope: 'user:inference user:profile',
    });
    expect(JSON.parse(readFileSync(credentials, 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'new-token',
        refreshToken: 'new-refresh-token',
        expiresAt: 3_610_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    });
  });

  it('refreshes expired DB credentials JSON and persists the rotated token bundle', async () => {
    let storedCredentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-db-token',
        refreshToken: 'db-refresh-token',
        expiresAt: 1_000,
        subscriptionType: 'max',
      },
      unrelatedRootField: 'preserve-me',
    });
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetch: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'new-db-token',
            refresh_token: 'new-db-refresh-token',
            expires_in: 3600,
          }),
      });
    };
    const provider = createClaudeOAuthTokenProvider({
      env: {},
      credentialsPath: '/does/not/exist',
      credentialsJsonProvider: () => storedCredentialsJson,
      credentialsJsonUpdater: (next) => {
        storedCredentialsJson = next;
      },
      fetch,
      now: () => 10_000,
      userAgent: 'claude-code/test',
    });

    await expect(provider()).resolves.toBe('new-db-token');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(storedCredentialsJson)).toEqual({
      claudeAiOauth: {
        accessToken: 'new-db-token',
        refreshToken: 'new-db-refresh-token',
        expiresAt: 3_610_000,
        subscriptionType: 'max',
      },
      unrelatedRootField: 'preserve-me',
    });
  });

  it('coalesces concurrent refreshes so a rotating refresh token is redeemed once', async () => {
    let storedCredentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-token',
        refreshToken: 'single-use-refresh-token',
        expiresAt: 1_000,
      },
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      await refreshStarted;
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'shared-access-token',
            refresh_token: 'next-refresh-token',
            expires_in: 3600,
          }),
      };
    };
    const provider = createClaudeOAuthTokenProvider({
      credentialsPath: '/does/not/exist',
      credentialsJsonProvider: () => storedCredentialsJson,
      credentialsJsonUpdater: (next) => {
        storedCredentialsJson = next;
      },
      fetch,
      now: () => 10_000,
    });

    const first = provider();
    const second = provider();
    releaseRefresh?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'shared-access-token',
      'shared-access-token',
    ]);
    expect(calls).toBe(1);
    expect(JSON.parse(storedCredentialsJson).claudeAiOauth.refreshToken).toBe('next-refresh-token');
  });

  it('retries persistence of a rotated token without redeeming the old token again', async () => {
    let storedCredentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-token',
        refreshToken: 'single-use-refresh-token',
        expiresAt: 1_000,
      },
    });
    let fetchCalls = 0;
    let persistCalls = 0;
    const provider = createClaudeOAuthTokenProvider({
      credentialsPath: '/does/not/exist',
      credentialsJsonProvider: () => storedCredentialsJson,
      credentialsJsonUpdater: (next) => {
        persistCalls += 1;
        if (persistCalls === 1) throw new Error('temporary DB failure');
        storedCredentialsJson = next;
      },
      fetch: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'rotated-access-token',
            refresh_token: 'rotated-refresh-token',
            expires_in: 3600,
          }),
        };
      },
      now: () => 10_000,
    });

    await expect(provider()).rejects.toThrow('temporary DB failure');
    await expect(provider()).resolves.toBe('rotated-access-token');
    expect(fetchCalls).toBe(1);
    expect(persistCalls).toBe(2);
    expect(JSON.parse(storedCredentialsJson).claudeAiOauth.refreshToken).toBe(
      'rotated-refresh-token',
    );
  });

  it('does not overwrite a newer login after rotated-token persistence failed', async () => {
    let storedCredentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-token',
        refreshToken: 'old-refresh-token',
        expiresAt: 1_000,
      },
    });
    let persistCalls = 0;
    const provider = createClaudeOAuthTokenProvider({
      credentialsPath: '/does/not/exist',
      credentialsJsonProvider: () => storedCredentialsJson,
      credentialsJsonUpdater: (next) => {
        persistCalls += 1;
        if (persistCalls === 1) throw new Error('temporary DB failure');
        storedCredentialsJson = next;
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'orphaned-access-token',
          refresh_token: 'orphaned-refresh-token',
          expires_in: 3600,
        }),
      }),
      now: () => 10_000,
    });

    await expect(provider()).rejects.toThrow('temporary DB failure');
    storedCredentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'new-login-access-token',
        refreshToken: 'new-login-refresh-token',
        expiresAt: 4_102_444_800_000,
      },
    });
    await expect(provider()).resolves.toBe('new-login-access-token');
    expect(persistCalls).toBe(1);
    expect(JSON.parse(storedCredentialsJson).claudeAiOauth.refreshToken).toBe(
      'new-login-refresh-token',
    );
  });

  it('does not resurrect credentials after logout during a failed rotated-token write', async () => {
    let storedCredentialsJson: string | undefined = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-token',
        refreshToken: 'old-refresh-token',
        expiresAt: 1_000,
      },
    });
    let persistCalls = 0;
    const provider = createClaudeOAuthTokenProvider({
      credentialsPath: '/does/not/exist',
      credentialsJsonProvider: () => storedCredentialsJson,
      credentialsJsonUpdater: () => {
        persistCalls += 1;
        throw new Error('temporary DB failure');
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'orphaned-access-token',
          refresh_token: 'orphaned-refresh-token',
          expires_in: 3600,
        }),
      }),
      now: () => 10_000,
    });

    await expect(provider()).rejects.toThrow('temporary DB failure');
    storedCredentialsJson = undefined;

    await expect(provider()).resolves.toBeUndefined();
    expect(persistCalls).toBe(1);
  });

  it('does not resurrect credentials when logout happens during refresh', async () => {
    let storedCredentialsJson: string | undefined = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-token',
        refreshToken: 'old-refresh-token',
        expiresAt: 1_000,
      },
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshCanFinish = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let notifyRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      notifyRefreshStarted = resolve;
    });
    let persistCalls = 0;
    const provider = createClaudeOAuthTokenProvider({
      credentialsPath: '/does/not/exist',
      credentialsJsonProvider: () => storedCredentialsJson,
      credentialsJsonUpdater: () => {
        persistCalls += 1;
      },
      fetch: async () => {
        notifyRefreshStarted?.();
        await refreshCanFinish;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'orphaned-access-token',
            refresh_token: 'orphaned-refresh-token',
            expires_in: 3600,
          }),
        };
      },
      now: () => 10_000,
    });

    const refreshing = provider();
    await refreshStarted;
    storedCredentialsJson = undefined;
    releaseRefresh?.();

    await expect(refreshing).resolves.toBeUndefined();
    expect(persistCalls).toBe(0);
    await expect(provider()).resolves.toBeUndefined();
  });

  it('supports an earlier refresh window for access tokens injected into long-lived agents', async () => {
    let storedCredentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'soon-expiring-token',
        refreshToken: 'refresh-token',
        expiresAt: 5 * 60_000,
      },
    });
    let calls = 0;
    const provider = createClaudeOAuthTokenProvider({
      credentialsPath: '/does/not/exist',
      credentialsJsonProvider: () => storedCredentialsJson,
      credentialsJsonUpdater: (next) => {
        storedCredentialsJson = next;
      },
      fetch: () => {
        calls += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              access_token: 'fresh-token',
              refresh_token: 'next-refresh-token',
              expires_in: 3600,
            }),
        });
      },
      now: () => 0,
      expirySkewMs: 10 * 60_000,
    });

    await expect(provider()).resolves.toBe('fresh-token');
    expect(calls).toBe(1);
  });

  it('uses a still-valid access token when an early refresh is temporarily rejected', async () => {
    const provider = createClaudeOAuthTokenProvider({
      credentialsPath: '/does/not/exist',
      credentialsJsonProvider: () =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'still-valid-token',
            refreshToken: 'refresh-token',
            expiresAt: 5 * 60_000,
          },
        }),
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      now: () => 0,
      expirySkewMs: 10 * 60_000,
    });

    await expect(provider()).resolves.toBe('still-valid-token');
  });

  it('refreshes credentials with a refresh token when expiresAt is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-claude-usage-'));
    const credentials = join(dir, '.credentials.json');
    writeFileSync(
      credentials,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'unknown-expiry-token',
          refreshToken: 'refresh-token',
        },
      }),
    );
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'new-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
      });
    };
    const provider = createClaudeOAuthTokenProvider({
      env: {},
      credentialsPath: credentials,
      fetch,
      now: () => 10_000,
    });

    await expect(provider()).resolves.toBe('new-token');
    expect(calls).toBe(1);
  });

  it('falls back to an unknown-expiry token when refresh fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-claude-usage-'));
    const credentials = join(dir, '.credentials.json');
    writeFileSync(
      credentials,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'unknown-expiry-token',
          refreshToken: 'refresh-token',
        },
      }),
    );
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    };
    const provider = createClaudeOAuthTokenProvider({
      env: {},
      credentialsPath: credentials,
      fetch,
      now: () => 10_000,
    });

    await expect(provider()).resolves.toBe('unknown-expiry-token');
    expect(calls).toBe(1);
  });

  it('merges refreshed tokens into the latest credentials file state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-claude-usage-'));
    const credentials = join(dir, '.credentials.json');
    writeFileSync(
      credentials,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: 1_000,
          subscriptionType: 'max',
        },
      }),
    );
    const fetch: FetchLike = () => {
      writeFileSync(
        credentials,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'other-process-token',
            refreshToken: 'refresh-token',
            expiresAt: 5_000,
            subscriptionType: 'max',
            rateLimitTier: 'default_claude_max_20x',
          },
          unrelatedRootField: 'preserve-me',
        }),
      );
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'new-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
      });
    };
    const provider = createClaudeOAuthTokenProvider({
      env: {},
      credentialsPath: credentials,
      fetch,
      now: () => 10_000,
    });

    await expect(provider()).resolves.toBe('new-token');
    expect(JSON.parse(readFileSync(credentials, 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'new-token',
        refreshToken: 'new-refresh-token',
        expiresAt: 3_610_000,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
      unrelatedRootField: 'preserve-me',
    });
  });

  it('returns undefined when expired credentials cannot refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-claude-usage-'));
    const credentials = join(dir, '.credentials.json');
    writeFileSync(
      credentials,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: 1_000,
        },
      }),
    );
    const fetch: FetchLike = () =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    const provider = createClaudeOAuthTokenProvider({
      env: {},
      credentialsPath: credentials,
      fetch,
      now: () => 10_000,
    });

    await expect(provider()).resolves.toBeUndefined();
  });
});

describe('createClaudeUsageService', () => {
  it('yields [] and never fetches without a token', async () => {
    const { fetch, calls } = okFetch(USAGE_BODY);
    const svc = createClaudeUsageService({ fetch, now: () => 0 });
    expect(await svc.getLimits()).toEqual([]);
    expect(calls()).toBe(0);
  });

  it('fetches once, caches within the TTL, and refetches after it', async () => {
    let t = 1_000;
    const { fetch, calls } = okFetch(USAGE_BODY);
    const svc = createClaudeUsageService({ token: 'tok', fetch, now: () => t, ttlMs: 60_000 });

    const first = await svc.getLimits();
    expect(first).toHaveLength(2);
    expect(calls()).toBe(1);

    t += 30_000; // still within TTL
    await svc.getLimits();
    expect(calls()).toBe(1);

    t += 40_000; // now past TTL (70s elapsed)
    await svc.getLimits();
    expect(calls()).toBe(2);
  });

  it('stamps when the reading was taken so the fresh probe outranks a stale event', async () => {
    const { fetch } = okFetch(USAGE_BODY);
    const svc = createClaudeUsageService({ token: 'tok', fetch, now: () => 1_781_000_000_000 });

    for (const limit of await svc.getLimits()) {
      expect(limit.observedAt).toBe(1_781_000_000_000);
    }
  });

  it('uses a token provider when no fixed token is configured', async () => {
    const t = 1_000;
    const tokens: string[] = [];
    const fetch: FetchLike = (_url, init) => {
      tokens.push(init.headers.authorization ?? '');
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(USAGE_BODY) });
    };
    const svc = createClaudeUsageService({
      tokenProvider: () => Promise.resolve('provided-token'),
      fetch,
      now: () => t,
      ttlMs: 10_000,
    });

    expect(await svc.getLimits()).toHaveLength(2);
    expect(tokens).toEqual(['Bearer provided-token']);
  });

  it('backs off when the token provider cannot produce a token', async () => {
    let t = 1_000;
    let tokenCalls = 0;
    const { fetch, calls } = okFetch(USAGE_BODY);
    const svc = createClaudeUsageService({
      tokenProvider: () => {
        tokenCalls += 1;
        return Promise.resolve(undefined);
      },
      fetch,
      now: () => t,
      minRetryMs: 60_000,
    });

    expect(await svc.getLimits()).toEqual([]);
    expect(tokenCalls).toBe(1);
    expect(calls()).toBe(0);

    t += 20_000; // still inside backoff
    expect(await svc.getLimits()).toEqual([]);
    expect(tokenCalls).toBe(1);
    expect(calls()).toBe(0);
  });

  it('backs off when the token provider throws', async () => {
    let t = 1_000;
    let tokenCalls = 0;
    const { fetch, calls } = okFetch(USAGE_BODY);
    const svc = createClaudeUsageService({
      tokenProvider: () => {
        tokenCalls += 1;
        throw new Error('refresh failed');
      },
      fetch,
      now: () => t,
      minRetryMs: 60_000,
    });

    await expect(svc.getLimits()).resolves.toEqual([]);
    expect(tokenCalls).toBe(1);
    expect(calls()).toBe(0);

    t += 20_000; // still inside backoff
    await expect(svc.getLimits()).resolves.toEqual([]);
    expect(tokenCalls).toBe(1);
    expect(calls()).toBe(0);
  });

  it('backs off on a 429 and keeps serving the last-good reading', async () => {
    let t = 0;
    let calls = 0;
    let ok = true;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        ok
          ? { ok: true, status: 200, json: () => Promise.resolve(USAGE_BODY) }
          : { ok: false, status: 429, json: () => Promise.resolve({}) },
      );
    };
    const svc = createClaudeUsageService({
      token: 'tok',
      fetch,
      now: () => t,
      ttlMs: 10_000,
      minRetryMs: 60_000,
    });

    const good = await svc.getLimits();
    expect(good).toHaveLength(2);
    expect(calls).toBe(1);

    ok = false; // endpoint now 429s
    t += 20_000; // past TTL → one refresh attempt, which 429s
    expect(await svc.getLimits()).toEqual(good); // last-good served
    expect(calls).toBe(2);

    t += 20_000; // still inside the 60s backoff → no new attempt
    expect(await svc.getLimits()).toEqual(good);
    expect(calls).toBe(2);
  });

  it('dedupes concurrent refreshes into a single request', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(USAGE_BODY) });
    };
    const svc = createClaudeUsageService({ token: 'tok', fetch, now: () => 0 });
    await Promise.all([svc.getLimits(), svc.getLimits(), svc.getLimits()]);
    expect(calls).toBe(1);
  });
});

describe('createClaudeUsageService diagnostics', () => {
  function recordingLogger(): {
    log: {
      debug(d: Record<string, unknown>, m: string): void;
      warn(d: Record<string, unknown>, m: string): void;
    };
    warns: Array<Record<string, unknown>>;
    debugs: Array<Record<string, unknown>>;
    /** Every logged (data, message) pair, for whole-payload assertions. */
    entries: Array<[Record<string, unknown>, string]>;
  } {
    const warns: Array<Record<string, unknown>> = [];
    const debugs: Array<Record<string, unknown>> = [];
    const entries: Array<[Record<string, unknown>, string]> = [];
    return {
      log: {
        debug: (d, m) => {
          debugs.push(d);
          entries.push([d, m]);
        },
        warn: (d, m) => {
          warns.push(d);
          entries.push([d, m]);
        },
      },
      warns,
      debugs,
      entries,
    };
  }

  it('warns with reason "no-token" when no token resolves', async () => {
    const { fetch } = okFetch(USAGE_BODY);
    const { log, warns } = recordingLogger();
    const svc = createClaudeUsageService({
      tokenProvider: () => Promise.resolve(undefined),
      fetch,
      now: () => 0,
      log,
    });
    await svc.getLimits();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.reason).toBe('no-token');
  });

  it('warns with the HTTP status on a non-2xx response', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    const { log, warns } = recordingLogger();
    const svc = createClaudeUsageService({ token: 'tok', fetch, now: () => 0, log });
    await svc.getLimits();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.reason).toBe('non-2xx');
    expect(warns[0]?.status).toBe(401);
  });

  it('warns with reason "empty-parse" on a 2xx body that parses to nothing', async () => {
    const { fetch } = okFetch({ unexpected: 'shape' });
    const { log, warns } = recordingLogger();
    const svc = createClaudeUsageService({ token: 'tok', fetch, now: () => 0, log });
    expect(await svc.getLimits()).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.reason).toBe('empty-parse');
  });

  it('logs debug (no warn) on a successful refresh', async () => {
    const { fetch } = okFetch(USAGE_BODY);
    const { log, warns, debugs } = recordingLogger();
    const svc = createClaudeUsageService({ token: 'tok', fetch, now: () => 0, log });
    expect(await svc.getLimits()).toHaveLength(2);
    expect(warns).toHaveLength(0);
    expect(debugs).toHaveLength(1);
    expect(debugs[0]?.windows).toBe(2);
  });

  it('warns with reason "exception" when the fetch throws', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('network down'));
    const { log, warns } = recordingLogger();
    const svc = createClaudeUsageService({ token: 'tok', fetch, now: () => 0, log });
    await svc.getLimits();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.reason).toBe('exception');
  });

  it('never puts the OAuth token in any log payload', async () => {
    // The primary security invariant: diagnostics must reason about failures
    // without ever surfacing the credential. Exercise a path that reaches the
    // authenticated request (non-2xx, so the token was sent) and assert the
    // secret is absent from every logged (data, message) pair.
    const secret = 'super-secret-oauth-token';
    const fetch: FetchLike = () =>
      Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
    const { log, entries } = recordingLogger();
    const svc = createClaudeUsageService({ token: secret, fetch, now: () => 0, log });
    await svc.getLimits();
    expect(entries).not.toHaveLength(0);
    expect(JSON.stringify(entries)).not.toContain(secret);
  });
});
