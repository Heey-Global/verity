import { describe, expect, it, vi } from 'vitest';
import type { UserGithubAuthorization } from '@verity/store';

import {
  createGitHubUserAuthorization,
  GITHUB_USER_CALLBACK_URL,
  GitHubUserAuthorizationError,
} from './github-user-authorization.js';
import type { HttpFetch } from './github.js';

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Awaited<
    ReturnType<HttpFetch>
  >;

function setup(options: { configured?: boolean; now?: () => number } = {}) {
  const saved = new Map<string, UserGithubAuthorization>();
  const requests: { url: string; body?: Record<string, string> }[] = [];
  let tokenAnswer: () => Awaited<ReturnType<HttpFetch>> = () =>
    json(200, {
      access_token: 'ghu_first',
      expires_in: 28_800,
      refresh_token: 'ghr_first',
      refresh_token_expires_in: 15_897_600,
    });
  const fetch = vi.fn<HttpFetch>(async (url, init) => {
    requests.push({
      url,
      ...(init?.body ? { body: JSON.parse(init.body) as Record<string, string> } : {}),
    });
    if (url.endsWith('/login/oauth/access_token')) return tokenAnswer();
    if (url.endsWith('/user')) return json(200, { id: 42, login: 'lena-dev' });
    return json(404, {});
  });
  const authorization = createGitHubUserAuthorization({
    store: {
      getVeritySettings: async () =>
        (options.configured ?? true)
          ? ({ githubAppClientId: 'Iv1.client', githubAppClientSecret: 'secret' } as never)
          : ({ githubAppClientId: null, githubAppClientSecret: null } as never),
      userGithubAuthorizations: {
        get: async (userId: string) => saved.get(userId),
        save: async (value: UserGithubAuthorization) => {
          saved.set(value.userId, value);
        },
        delete: async (userId: string) => {
          saved.delete(userId);
        },
      } as never,
    },
    fetch,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    authorization,
    saved,
    requests,
    fetch,
    answerTokens: (answer: () => Awaited<ReturnType<HttpFetch>>) => {
      tokenAnswer = answer;
    },
  };
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

describe('GitHub user authorization', () => {
  it('cannot start before the administrator gives Verity the App OAuth client', async () => {
    const { authorization } = setup({ configured: false });
    await expect(authorization.start('lena')).rejects.toMatchObject({ code: 'not_configured' });
    await expect(authorization.status('lena')).resolves.toEqual({
      configured: false,
      connected: false,
      login: null,
    });
  });

  it('stores the person own token after a round-trip they started', async () => {
    const { authorization, saved, requests } = setup();
    const { authorizeUrl } = await authorization.start('lena');
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe('Iv1.client');
    expect(url.searchParams.get('redirect_uri')).toBe(GITHUB_USER_CALLBACK_URL);
    await expect(
      authorization.complete('lena', { code: 'code-1', state: stateOf(authorizeUrl) }),
    ).resolves.toEqual({ login: 'lena-dev' });
    expect(requests[0]?.body).toMatchObject({ code: 'code-1', client_secret: 'secret' });
    expect(saved.get('lena')).toMatchObject({
      githubUserId: '42',
      login: 'lena-dev',
      accessToken: 'ghu_first',
      refreshToken: 'ghr_first',
    });
    await expect(authorization.status('lena')).resolves.toMatchObject({
      connected: true,
      login: 'lena-dev',
    });
  });

  // A state is the only thing tying GitHub's answer to a person. If Bob could
  // complete Lena's round-trip, or replay one, Lena's Verity user would end up
  // acting with Bob's GitHub account (or the reverse).
  it('accepts a sign-in only once and only from the person who started it', async () => {
    const { authorization, saved } = setup();
    const { authorizeUrl } = await authorization.start('lena');
    const state = stateOf(authorizeUrl);
    await expect(authorization.complete('bob', { code: 'c', state })).rejects.toMatchObject({
      code: 'invalid_state',
    });
    // The attempt above consumed it, so Lena cannot finish with a leaked state either.
    await expect(authorization.complete('lena', { code: 'c', state })).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(saved.size).toBe(0);
  });

  it('expires an unfinished sign-in', async () => {
    let now = 0;
    const { authorization } = setup({ now: () => now });
    const { authorizeUrl } = await authorization.start('lena');
    now = 10 * 60_000;
    await expect(
      authorization.complete('lena', { code: 'c', state: stateOf(authorizeUrl) }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('never echoes GitHub response bodies in its errors', async () => {
    const { authorization, answerTokens } = setup();
    answerTokens(() => json(200, { error: 'bad_verification_code', error_description: 'code-1' }));
    const { authorizeUrl } = await authorization.start('lena');
    const failure = await authorization
      .complete('lena', { code: 'code-1', state: stateOf(authorizeUrl) })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubUserAuthorizationError);
    expect((failure as Error).message).not.toContain('code-1');
  });

  it('renews an expiring token once, keeping the rotated refresh token', async () => {
    let now = 0;
    const { authorization, saved, fetch, answerTokens } = setup({ now: () => now });
    const { authorizeUrl } = await authorization.start('lena');
    await authorization.complete('lena', { code: 'c', state: stateOf(authorizeUrl) });
    await expect(authorization.accessToken('lena')).resolves.toBe('ghu_first');

    now = 28_800_000 - 60_000;
    answerTokens(() =>
      json(200, { access_token: 'ghu_second', expires_in: 28_800, refresh_token: 'ghr_second' }),
    );
    const calls = fetch.mock.calls.length;
    const [one, two] = await Promise.all([
      authorization.accessToken('lena'),
      authorization.accessToken('lena'),
    ]);
    expect([one, two]).toEqual(['ghu_second', 'ghu_second']);
    // GitHub rotates the refresh token on use: a second concurrent renewal with
    // the old one would fail and could lock the person out.
    expect(fetch.mock.calls.length - calls).toBe(1);
    expect(saved.get('lena')?.refreshToken).toBe('ghr_second');
  });

  it('gives no token when renewal is refused, rather than an expired one', async () => {
    let now = 0;
    const { authorization, answerTokens } = setup({ now: () => now });
    const { authorizeUrl } = await authorization.start('lena');
    await authorization.complete('lena', { code: 'c', state: stateOf(authorizeUrl) });
    now = 28_800_000;
    answerTokens(() => json(200, { error: 'bad_refresh_token' }));
    await expect(authorization.accessToken('lena')).resolves.toBeUndefined();
    await expect(authorization.accessToken('bob')).resolves.toBeUndefined();
  });
});
