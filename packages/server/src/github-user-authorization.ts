import { randomBytes } from 'node:crypto';
import type { EventStore } from '@verity/store';
import type { HttpFetch } from './github.js';

/**
 * Each person authorizes the instance's GitHub App for themselves (ADR 0023 §3).
 * GitHub then issues them a user-to-server token limited to the intersection of
 * the App's installation and their own repository permissions, so Verity never
 * shows or does on GitHub what that person could not.
 *
 * The App is the installation's; only its OAuth client (id and secret) is used
 * here. The browser round-trip returns through the website's claimed link to
 * the app, which forwards `code` and `state` over its authenticated transport —
 * the Server need not be reachable from a browser.
 */
export const GITHUB_USER_CALLBACK_URL = 'https://verity.build/github/user/callback';

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 256;
/** Renew this long before GitHub's 8-hour expiry so a push never races it. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class GitHubUserAuthorizationError extends Error {
  constructor(
    readonly code:
      'not_configured' | 'invalid_state' | 'rejected' | 'unreachable' | 'unexpected_response',
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubUserAuthorizationStatus {
  /** Whether the administrator has given Verity the App's OAuth client. */
  configured: boolean;
  connected: boolean;
  login: string | null;
}

export interface GitHubUserAuthorization {
  start(userId: string): Promise<{ authorizeUrl: string }>;
  complete(userId: string, input: { code: string; state: string }): Promise<{ login: string }>;
  status(userId: string): Promise<GitHubUserAuthorizationStatus>;
  disconnect(userId: string): Promise<void>;
  /** The person's current token, renewed when close to expiry; undefined when
   *  they have not authorized GitHub or the authorization can no longer renew. */
  accessToken(userId: string): Promise<string | undefined>;
}

interface TokenResponse {
  accessToken: string;
  accessExpiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
}

export function createGitHubUserAuthorization(deps: {
  store: Pick<EventStore, 'getVeritySettings' | 'userGithubAuthorizations'>;
  fetch?: HttpFetch;
  now?: () => number;
  webBaseUrl?: string;
  apiBaseUrl?: string;
}): GitHubUserAuthorization {
  const doFetch: HttpFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const webBaseUrl = (deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/u, '');
  const apiBaseUrl = (deps.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/u, '');
  /** One-use state → the person who started the round-trip. */
  const pending = new Map<string, { userId: string; expiresAt: number }>();
  /** One renewal per person at a time; GitHub rotates the refresh token on use. */
  const renewing = new Map<string, Promise<string | undefined>>();

  const client = async () => {
    const settings = await deps.store.getVeritySettings();
    const clientId = settings?.githubAppClientId?.trim();
    const clientSecret = settings?.githubAppClientSecret?.trim();
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };

  const purge = (instant: number) => {
    for (const [state, entry] of pending) if (entry.expiresAt <= instant) pending.delete(state);
  };

  // Never surfaces a response body: GitHub can echo the code or a token there.
  const exchange = async (body: Record<string, string>): Promise<TokenResponse> => {
    let response;
    try {
      response = await doFetch(`${webBaseUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GitHubUserAuthorizationError('unreachable', 'could not reach GitHub');
    }
    if (!response.ok)
      throw new GitHubUserAuthorizationError(
        'rejected',
        `GitHub rejected the authorization (HTTP ${String(response.status)})`,
      );
    const parsed = (await response.json()) as Record<string, unknown>;
    if (typeof parsed['error'] === 'string')
      throw new GitHubUserAuthorizationError('rejected', 'GitHub rejected the authorization');
    const accessToken = parsed['access_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0)
      throw new GitHubUserAuthorizationError(
        'unexpected_response',
        'GitHub returned an unexpected authorization response',
      );
    const seconds = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? new Date(now() + value * 1000)
        : null;
    const refreshToken = parsed['refresh_token'];
    return {
      accessToken,
      accessExpiresAt: seconds(parsed['expires_in']),
      refreshToken:
        typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : null,
      refreshExpiresAt: seconds(parsed['refresh_token_expires_in']),
    };
  };

  const githubUser = async (accessToken: string) => {
    let response;
    try {
      response = await doFetch(`${apiBaseUrl}/user`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'verity',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GitHubUserAuthorizationError('unreachable', 'could not reach GitHub');
    }
    if (!response.ok)
      throw new GitHubUserAuthorizationError(
        'rejected',
        `GitHub rejected the authorization (HTTP ${String(response.status)})`,
      );
    const user = (await response.json()) as Record<string, unknown>;
    const id = user['id'];
    const login = user['login'];
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof login !== 'string')
      throw new GitHubUserAuthorizationError(
        'unexpected_response',
        'GitHub returned an unexpected user',
      );
    return { githubUserId: String(id), login };
  };

  const renew = async (userId: string): Promise<string | undefined> => {
    const current = await deps.store.userGithubAuthorizations.get(userId);
    if (!current) return undefined;
    const instant = now();
    if (
      current.accessExpiresAt === null ||
      current.accessExpiresAt.getTime() - REFRESH_MARGIN_MS > instant
    )
      return current.accessToken;
    const credentials = await client();
    if (
      !credentials ||
      current.refreshToken === null ||
      (current.refreshExpiresAt !== null && current.refreshExpiresAt.getTime() <= instant)
    )
      return undefined;
    let tokens: TokenResponse;
    try {
      tokens = await exchange({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });
    } catch {
      return undefined;
    }
    await deps.store.userGithubAuthorizations.save({
      userId,
      githubUserId: current.githubUserId,
      login: current.login,
      ...tokens,
    });
    return tokens.accessToken;
  };

  return {
    async start(userId) {
      const credentials = await client();
      if (!credentials)
        throw new GitHubUserAuthorizationError(
          'not_configured',
          'GitHub sign-in for people is not set up on this server yet',
        );
      const instant = now();
      purge(instant);
      if (pending.size >= MAX_PENDING)
        throw new GitHubUserAuthorizationError('unreachable', 'too many pending GitHub sign-ins');
      const state = randomBytes(32).toString('base64url');
      pending.set(state, { userId, expiresAt: instant + STATE_TTL_MS });
      const url = new URL(`${webBaseUrl}/login/oauth/authorize`);
      url.searchParams.set('client_id', credentials.clientId);
      url.searchParams.set('redirect_uri', GITHUB_USER_CALLBACK_URL);
      url.searchParams.set('state', state);
      return { authorizeUrl: url.toString() };
    },
    async complete(userId, { code, state }) {
      const entry = pending.get(state);
      // One use only, and only by the person who started it: a state handed to
      // someone else must not attach their GitHub account to this person.
      pending.delete(state);
      if (!entry || entry.userId !== userId || entry.expiresAt <= now())
        throw new GitHubUserAuthorizationError(
          'invalid_state',
          'This GitHub sign-in expired or belongs to someone else; start it again',
        );
      const credentials = await client();
      if (!credentials)
        throw new GitHubUserAuthorizationError(
          'not_configured',
          'GitHub sign-in for people is not set up on this server yet',
        );
      const tokens = await exchange({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        redirect_uri: GITHUB_USER_CALLBACK_URL,
      });
      const user = await githubUser(tokens.accessToken);
      await deps.store.userGithubAuthorizations.save({ userId, ...user, ...tokens });
      return { login: user.login };
    },
    async status(userId) {
      const [credentials, authorization] = await Promise.all([
        client(),
        deps.store.userGithubAuthorizations.get(userId),
      ]);
      return {
        configured: credentials !== undefined,
        connected: authorization !== undefined,
        login: authorization?.login ?? null,
      };
    },
    async disconnect(userId) {
      await deps.store.userGithubAuthorizations.delete(userId);
    },
    accessToken(userId) {
      const running = renewing.get(userId);
      if (running) return running;
      const next = renew(userId).finally(() => renewing.delete(userId));
      renewing.set(userId, next);
      return next;
    },
  };
}
