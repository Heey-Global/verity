import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexCredentialAuthority } from './codex-credential-authority.js';
import {
  CodexCredentialUnavailableError,
  CodexSignInUnusableError,
} from './codex-sign-in-error.js';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

describe('Codex gateway credential authority', () => {
  // In a hook, not at the end of the test body: an assertion that throws would
  // otherwise leave `globalThis.fetch` spied for every test after it.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a current credential without refreshing it', async () => {
    const refresh = vi.fn();
    const persist = vi.fn();
    const authority = new CodexCredentialAuthority(
      authJson(jwt({ exp: NOW / 1_000 + 3_600, chatgpt_account_id: 'account-1' })),
      { refresh, persist, now: () => NOW },
    );

    await expect(authority.resolve()).resolves.toEqual({
      accessToken: expect.any(String),
      accountId: 'account-1',
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('serializes refresh and persists a rotated token before publishing it', async () => {
    let persisted = false;
    const refresh = vi.fn(async () => ({
      access_token: jwt({ exp: NOW / 1_000 + 3_600, chatgpt_account_id: 'account-1' }),
      refresh_token: 'refresh-2',
      id_token: jwt({ chatgpt_account_id: 'account-1' }),
    }));
    const persist = vi.fn(async () => {
      persisted = true;
    });
    const authority = new CodexCredentialAuthority(
      authJson(jwt({ exp: NOW / 1_000 + 30 }), 'refresh-1'),
      { refresh, persist, now: () => NOW },
    );

    const credentials = await Promise.all([authority.resolve(), authority.resolve()]);

    expect(refresh).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(persisted).toBe(true);
    expect(credentials).toEqual([
      expect.objectContaining({ accountId: 'account-1' }),
      expect.objectContaining({ accountId: 'account-1' }),
    ]);
    expect(authority.snapshot()).toContain('refresh-2');
  });

  it('keeps the old in-memory credential when write-ahead persistence fails', async () => {
    const authority = new CodexCredentialAuthority(
      authJson(jwt({ exp: NOW / 1_000 + 30 }), 'refresh-1'),
      {
        refresh: async () => ({
          access_token: jwt({ exp: NOW / 1_000 + 3_600, chatgpt_account_id: 'account-1' }),
          refresh_token: 'refresh-2',
        }),
        persist: () => Promise.reject(new Error('disk unavailable')),
        now: () => NOW,
      },
    );

    await expect(authority.resolve()).rejects.toThrow('disk unavailable');
    expect(authority.snapshot()).toContain('refresh-1');
    expect(authority.snapshot()).not.toContain('refresh-2');
  });

  it('coalesces concurrent unauthorized refreshes for one access token', async () => {
    const refresh = vi.fn(async () => ({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
    }));
    const authority = new CodexCredentialAuthority(authJson('access-1', 'refresh-1'), {
      refresh,
      persist: vi.fn(async () => undefined),
      now: () => NOW,
    });

    await Promise.all([
      authority.refreshAfterUnauthorized('access-1'),
      authority.refreshAfterUnauthorized('access-1'),
    ]);

    expect(refresh).toHaveBeenCalledOnce();
    expect(authority.snapshot()).toContain('refresh-2');
  });

  it('rejects incomplete login material without reflecting tokens', () => {
    expect(() => new CodexCredentialAuthority('{"tokens":{}}', { persist: vi.fn() })).toThrow(
      CodexCredentialUnavailableError,
    );
  });

  // Siblings, not parent and child — the one line of the design that is a class
  // hierarchy rather than a value. `codexUsage` reads `CodexSignInUnusableError`
  // as "signing in again fixes this", and this error is raised for the opposite
  // case too: a token endpoint nobody could reach. Re-parenting it would make
  // every unreachable endpoint a refused sign-in, and every other test here would
  // still pass, because they all assert the FLAG.
  it('is not the error that means a sign-in was refused', () => {
    expect(new CodexCredentialUnavailableError('x')).not.toBeInstanceOf(CodexSignInUnusableError);
    expect(new CodexCredentialUnavailableError('x', { signInRejected: true })).not.toBeInstanceOf(
      CodexSignInUnusableError,
    );
  });

  // Not the banner path — `parseCodexAuthJson` runs from the constructor, and its
  // documentation says where that lands: a failed CONFIGURE, no authority at all,
  // and a token read that answers "no login installed". What is pinned here is
  // only that the classification is right about the material it is handed, so it
  // stays right if that path is ever wired through. The verdict that does reach
  // the operator is made at `resolve()`, in the two tests below.
  it('marks stored login material a new sign-in would replace', () => {
    const rejected = (authJsonText: string): boolean => {
      try {
        new CodexCredentialAuthority(authJsonText, { persist: vi.fn() });
        return false;
      } catch (error) {
        return error instanceof CodexCredentialUnavailableError && error.signInRejected;
      }
    };

    expect(rejected('not json')).toBe(true);
    expect(rejected('{"auth_mode":"chatgpt"}')).toBe(true);
    expect(rejected('{"tokens":{"access_token":"a"}}')).toBe(true);
  });

  // The same defect, classified by where the document came from. A stored login
  // with no account id is one a new sign-in replaces; the same gap in a document
  // the token endpoint rewrote a moment ago is that endpoint having changed shape,
  // and no amount of signing in again puts the claim back.
  it('blames the login for an unreadable document only while it is the stored one', async () => {
    const withoutAccountId = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: jwt({ exp: NOW / 1_000 + 3_600 }), refresh_token: 'refresh-1' },
    });

    await expect(
      new CodexCredentialAuthority(withoutAccountId, {
        persist: vi.fn(),
        now: () => NOW,
      }).resolve(),
    ).rejects.toMatchObject({ signInRejected: true });

    // A stored login that reads fine — its account id rides in the access token's
    // claims — but is due for a refresh.
    const claimOnly = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: jwt({ exp: NOW / 1_000 + 30, chatgpt_account_id: 'account-1' }),
        refresh_token: 'refresh-1',
      },
    });

    await expect(
      new CodexCredentialAuthority(claimOnly, {
        // Answers the refresh, and answers it with the claim dropped.
        refresh: async () => ({ access_token: jwt({ exp: NOW / 1_000 + 3_600 }) }),
        persist: vi.fn(async () => undefined),
        now: () => NOW,
      }).resolve(),
    ).rejects.toMatchObject({ signInRejected: false });
  });

  // Through the real refresh path rather than an injected stub: the classification
  // is made where the OAuth response is read, so a stub that skips it would only
  // re-assert whatever the test itself constructed.
  it.each([
    {
      what: 'a token endpoint it could not reach',
      // A new sign-in would have to reach the same host, so it fixes nothing.
      respond: () => Promise.reject(new Error('ECONNREFUSED')),
      signInRejected: false,
    },
    {
      what: 'a refresh answer it could not use',
      // Reached, answered, and the answer carried no token: an upstream change or
      // outage, not a login that has gone stale.
      respond: () => Promise.resolve(new Response('{}', { status: 200 })),
      signInRejected: false,
    },
    {
      // Reached, and the stored refresh token itself was turned down — revoked,
      // expired, or superseded elsewhere. This is the one a new sign-in answers,
      // and the body is what says so.
      what: 'a refresh the endpoint turned down',
      respond: () => Promise.resolve(new Response('{"error":"invalid_grant"}', { status: 400 })),
      signInRejected: true,
    },
    {
      // Same status, and this client's fault rather than the login's: nothing about
      // signing in again changes how the request is built.
      what: 'a refresh request the endpoint could not parse',
      respond: () => Promise.resolve(new Response('{"error":"invalid_request"}', { status: 400 })),
      signInRejected: false,
    },
    {
      // A 400 whose body says nothing usable. Read as not the login's fault, so a
      // shape this Server does not recognise costs a silent banner, not a dead tap.
      what: 'a refusal it cannot read',
      respond: () => Promise.resolve(new Response('<html>bad request</html>', { status: 400 })),
      signInRejected: false,
    },
    {
      // A block on a login that is otherwise fine — policy, region, an org rule.
      // Signing in again lands behind the same block.
      what: 'a refresh the endpoint forbade',
      respond: () => Promise.resolve(new Response('{"error":"access_denied"}', { status: 403 })),
      signInRejected: false,
    },
    {
      // Rate limiting is the endpoint asking to be asked again, with a login that is
      // still perfectly good behind it. Offering a re-login here would be a dead end.
      what: 'a refresh the endpoint rate limited',
      respond: () => Promise.resolve(new Response('{}', { status: 429 })),
      signInRejected: false,
    },
    {
      // Same for an outage: the stored token was never judged at all.
      what: 'a refresh the endpoint failed to serve',
      respond: () => Promise.resolve(new Response('{}', { status: 503 })),
      signInRejected: false,
    },
  ])('classifies $what', async ({ respond, signInRejected }) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(respond);
    const authority = new CodexCredentialAuthority(authJson(jwt({ exp: NOW / 1_000 + 30 })), {
      persist: vi.fn(),
      now: () => NOW,
    });

    await expect(authority.resolve()).rejects.toMatchObject({ signInRejected });
  });

  // The refusal is read out of the response BODY, and the whole refresh runs under
  // the single-writer lock. An endpoint that accepts the connection and then goes
  // quiet would hold that lock — and every Codex request and usage probe queued
  // behind it — for as long as it cared to, so the request carries a deadline.
  it('bounds the refresh request rather than waiting on the endpoint', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 503 }));
    const authority = new CodexCredentialAuthority(authJson(jwt({ exp: NOW / 1_000 + 30 })), {
      persist: vi.fn(),
      now: () => NOW,
    });

    await expect(authority.resolve()).rejects.toThrow(CodexCredentialUnavailableError);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

function authJson(accessToken: string, refreshToken = 'refresh-1'): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: accessToken, refresh_token: refreshToken, account_id: 'account-1' },
    last_refresh: new Date(NOW).toISOString(),
  });
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}
