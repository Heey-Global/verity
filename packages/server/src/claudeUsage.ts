import { renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RateLimitState } from '@verity/events';

/**
 * Claude subscription quota probe.
 *
 * The Claude apps + Claude Code show a "Nutzung / Usage" panel (5-hour session
 * window + weekly limits, each with a used-percent + reset time). That data comes
 * from an UNDOCUMENTED OAuth endpoint — `GET https://api.anthropic.com/api/oauth/usage`
 * — NOT from the stream-json `rate_limit_event` (which carries only status +
 * resetsAt, no percentage). Verity stores Claude's refreshable
 * `~/.claude/.credentials.json`, so the server can read the endpoint and surface
 * a real usage gauge for Claude on the overview, at parity with Codex.
 *
 * ‼️ The endpoint rate-limits itself HARD: even 30–60s polling triggers a 429 that
 * sticks for 30+ minutes with no `Retry-After` (anthropics/claude-code#31637). And
 * the `User-Agent: claude-code/<version>` header is REQUIRED — without it you land
 * in an even stricter bucket. So this service:
 *   - is the SINGLE server-side poller (the value is account-global — one fetch
 *     serves every overview client; the mobile app polls Verity's cached copy, not
 *     Anthropic),
 *   - refreshes lazily at most once per {@link ClaudeUsageOptions.ttlMs} (default
 *     5 min) and only when asked,
 *   - backs off exponentially on failure and keeps serving the last-good value,
 *   - never throws — an unavailable probe just yields `[]`, and the overview falls
 *     back to the reset-only signal from the event stream.
 */

/** One quota window as the endpoint reports it. */
interface UsageWindow {
  /** Percent of the window consumed, 0–100 (0 = fresh / no active window). */
  utilization: number;
  /** ISO-8601 UTC instant at which the window resets. */
  resets_at: string;
}

/** The `/api/oauth/usage` response body (only the fields we consume). */
interface UsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  /** Model-scoped weekly windows; `null` when the plan doesn't split them. */
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Beta flag the OAuth endpoints require. */
const OAUTH_BETA = 'oauth-2025-04-20';
/** Any `claude-code/<version>` UA escapes the strict rate-limit bucket. */
const DEFAULT_USER_AGENT = 'claude-code/2.0.0';
/** Claude Code's public OAuth client id for subscription/OAuth token refresh. */
const DEFAULT_CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Refresh shortly before expiry so the usage fetch never races an expired token. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;
/** Success cache TTL — how long a good reading is served before a refetch. */
const DEFAULT_TTL_MS = 5 * 60_000;
/** First backoff step after a failure; doubles up to the cap. */
const DEFAULT_MIN_RETRY_MS = 60_000;
/** Backoff ceiling (matches the endpoint's own observed plateau). */
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

function isWindow(value: unknown): value is UsageWindow {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Record<string, unknown>;
  return typeof w.utilization === 'number' && typeof w.resets_at === 'string';
}

/**
 * Map one usage window onto the canonical {@link RateLimitState}. Returns null when
 * the window is absent/malformed or its reset timestamp doesn't parse. `resets_at`
 * is ISO-8601; our `resetsAt` is epoch SECONDS. A window at/over 100% is surfaced
 * as `rejected` so the meter reads it as blocked, mirroring a live `rate_limit`.
 */
function toState(
  window: UsageWindow | null | undefined,
  canonical: RateLimitState['window'],
  observedAt: number | undefined,
): RateLimitState | null {
  if (!isWindow(window)) return null;
  const resetMs = Date.parse(window.resets_at);
  if (Number.isNaN(resetMs)) return null;
  return {
    status: window.utilization >= 100 ? 'rejected' : 'allowed',
    resetsAt: Math.floor(resetMs / 1000),
    window: canonical,
    usedPercent: window.utilization,
    providerLabel: 'Claude',
    ...(observedAt === undefined ? {} : { observedAt }),
  };
}

/**
 * Parse a `/api/oauth/usage` body into canonical Claude quota states. Pure +
 * defensive: unknown/garbled input yields `[]` rather than throwing. Maps
 * `five_hour` → five-hour window and `seven_day` → weekly window (the "all models"
 * weekly cap the app labels "Alle Modelle"); model-split weekly windows are ignored
 * for now (our meter shows one weekly row per provider).
 *
 * `observedAt` stamps when the reading was taken. The overview merges the probe
 * with the per-session event signal and prefers the more recently observed of the
 * two, so an unstamped probe state loses to a stale session event.
 */
export function parseClaudeUsage(body: unknown, observedAt?: number): RateLimitState[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = body as UsageResponse;
  const states: RateLimitState[] = [];
  const fiveHour = toState(data.five_hour, 'five_hour', observedAt);
  if (fiveHour) states.push(fiveHour);
  const weekly = toState(data.seven_day, 'weekly', observedAt);
  if (weekly) states.push(weekly);
  return states;
}

/** Minimal fetch surface (Node 24 global `fetch`), injectable for tests. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; method?: string; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type ClaudeOAuthTokenProvider = (() => Promise<string | undefined>) & {
  /** Explicit login/logout wins over any rotated bundle retained after a failed write. */
  discardPendingCredentials?: () => void;
};
type ClaudeCredentialsJsonProvider = () => Promise<string | undefined> | string | undefined;
type ClaudeCredentialsJsonUpdater = (credentialsJson: string) => Promise<void> | void;

/**
 * Structured logger for the probe's failure branches. The Fastify `app.log`
 * (pino) satisfies this shape as-is. Kept optional — callers that don't pass one
 * get a silent no-op, preserving the "never throws, never noisy" contract while
 * making an empty Claude meter diagnosable when a logger IS wired.
 */
interface ClaudeUsageLogger {
  debug(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
}

const NOOP_LOGGER: ClaudeUsageLogger = {
  debug: () => {},
  warn: () => {},
};

export interface ClaudeUsageOptions {
  /** Diagnostic logger. When supplied, each failure branch (no token, non-2xx,
   *  2xx-but-empty parse, exception) logs a reason so an empty Claude meter can be
   *  traced. Never logs the token itself. Defaults to a no-op. */
  log?: ClaudeUsageLogger;
  /** OAuth access token. Absent → the probe is inert and always yields `[]` (no
   *  request is ever made). Prefer `tokenProvider` for refreshable credentials. */
  token?: string | undefined;
  /** OAuth token provider, used when the token can expire (Claude credentials file). */
  tokenProvider?: ClaudeOAuthTokenProvider | undefined;
  /** HTTP client. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Clock, injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** `claude-code/<version>` UA. A real installed version is ideal but any value
   *  in this shape avoids the strict bucket. */
  userAgent?: string;
  /** Success cache TTL (ms). */
  ttlMs?: number;
  /** First backoff step (ms). */
  minRetryMs?: number;
  /** Backoff ceiling (ms). */
  maxBackoffMs?: number;
}

export interface ClaudeUsageService {
  /** Latest Claude account quota windows (five-hour + weekly), cached + backed off.
   *  Never throws; `[]` when the probe is unconfigured or has no good reading yet. */
  getLimits(): Promise<RateLimitState[]>;
}

interface ClaudeCredentialsFile {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    clientId?: unknown;
    scopes?: unknown;
  };
}

interface OAuthRefreshResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
}

function parseCredentialsFile(credentialsPath: string): ClaudeCredentialsFile | undefined {
  return parseCredentialsJson(readCredentialFile(credentialsPath));
}

function readCredentialFile(credentialsPath: string): string | undefined {
  try {
    return readFileSync(credentialsPath, 'utf8');
  } catch {
    return undefined;
  }
}

function parseCredentialsJson(value: string | undefined): ClaudeCredentialsFile | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function tokenExpiresAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function accessTokenFromFile(credentialsPath: string): string | undefined {
  const oauth = parseCredentialsFile(credentialsPath)?.claudeAiOauth;
  const accessToken = oauth?.accessToken;
  return typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : undefined;
}

function writeCredentialsAtomic(credentialsPath: string, credentials: ClaudeCredentialsFile): void {
  const tmpPath = `${credentialsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, credentialsPath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only; preserve the original write error.
    }
    throw error;
  }
}

async function readCredentialsJson(
  provider: ClaudeCredentialsJsonProvider | undefined,
): Promise<string | undefined> {
  if (provider === undefined) return undefined;
  const value = typeof provider === 'function' ? await provider() : provider;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringifyCredentials(credentials: ClaudeCredentialsFile): string {
  return JSON.stringify(credentials, null, 2) + '\n';
}

function scopesFromCredentials(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = value.filter(
    (scope): scope is string => typeof scope === 'string' && scope.length > 0,
  );
  return scopes.length === 0 ? undefined : scopes.join(' ');
}

export function resolveClaudeOAuthToken(
  credentialsPath = join(homedir(), '.claude', '.credentials.json'),
): string | undefined {
  return accessTokenFromFile(credentialsPath);
}

export function createClaudeOAuthTokenProvider(
  opts: {
    env?: NodeJS.ProcessEnv;
    credentialsPath?: string;
    credentialsJsonProvider?: ClaudeCredentialsJsonProvider;
    credentialsJsonUpdater?: ClaudeCredentialsJsonUpdater;
    fetch?: FetchLike;
    now?: () => number;
    userAgent?: string;
    /** Refresh this long before expiry; agent processes cannot change env mid-run. */
    expirySkewMs?: number;
  } = {},
): ClaudeOAuthTokenProvider {
  const credentialsPath = opts.credentialsPath ?? join(homedir(), '.claude', '.credentials.json');
  const doFetch =
    opts.fetch ??
    (typeof globalThis.fetch === 'function'
      ? (url, init) => globalThis.fetch(url, init)
      : undefined);
  const now = opts.now ?? Date.now;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const expirySkewMs = opts.expirySkewMs ?? TOKEN_EXPIRY_SKEW_MS;
  let inFlight: Promise<string | undefined> | undefined;
  let pendingCredentials:
    | {
        json: string;
        parsed: ClaudeCredentialsFile;
        accessToken: string;
        sourceJson: string;
      }
    | undefined;

  const currentCredentialsJson = async (): Promise<string | undefined> =>
    (await readCredentialsJson(opts.credentialsJsonProvider)) ??
    readCredentialFile(credentialsPath);

  const persistPendingCredentials = async (): Promise<void> => {
    if (pendingCredentials === undefined) return;
    if (opts.credentialsJsonUpdater !== undefined) {
      await opts.credentialsJsonUpdater(pendingCredentials.json);
    } else {
      writeCredentialsAtomic(credentialsPath, pendingCredentials.parsed);
    }
    pendingCredentials = undefined;
  };

  const resolveToken = async (): Promise<string | undefined> => {
    // Anthropic may already have consumed the old rotating refresh token even if
    // our first DB write failed. Retain the response in memory and retry that
    // exact durable write only while the durable source is still the version the
    // refresh began from. Logout/reconnect must invalidate this pending result.
    if (pendingCredentials !== undefined) {
      const pending = pendingCredentials;
      const currentJson = (await currentCredentialsJson())?.trim();
      if (currentJson === pending.json.trim()) {
        pendingCredentials = undefined;
        return pending.accessToken;
      }
      if (currentJson === pending.sourceJson.trim()) {
        await persistPendingCredentials();
        return pending.accessToken;
      }
      pendingCredentials = undefined;
    }
    const providedCredentialsJson = await currentCredentialsJson();
    if (providedCredentialsJson === undefined) return undefined;
    const credentials = parseCredentialsJson(providedCredentialsJson);
    const oauth = credentials?.claudeAiOauth;
    if (!credentials || !oauth) return undefined;

    const accessToken = oauth.accessToken;
    const expiresAt = tokenExpiresAt(oauth.expiresAt);
    const refreshToken = oauth.refreshToken;
    const hasRefreshToken = typeof refreshToken === 'string' && refreshToken.length > 0;
    const usableAccessToken =
      typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : undefined;
    const fallbackUsableToken = (): string | undefined =>
      expiresAt === undefined || expiresAt > now() ? usableAccessToken : undefined;
    if (
      usableAccessToken !== undefined &&
      (expiresAt === undefined ? !hasRefreshToken : expiresAt - expirySkewMs > now())
    ) {
      return usableAccessToken;
    }

    if (!hasRefreshToken || !doFetch) return undefined;
    const clientId =
      typeof oauth.clientId === 'string' && oauth.clientId.length > 0
        ? oauth.clientId
        : DEFAULT_CLAUDE_CODE_CLIENT_ID;
    const scope = scopesFromCredentials(oauth.scopes);

    try {
      const res = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'anthropic-beta': OAUTH_BETA,
          'content-type': 'application/json',
          'user-agent': userAgent,
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          ...(scope === undefined ? {} : { scope }),
        }),
      });
      if (!res.ok) return fallbackUsableToken();
      const body = (await res.json()) as OAuthRefreshResponse;
      if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
        return fallbackUsableToken();
      }
      const nextRefreshToken =
        typeof body.refresh_token === 'string' && body.refresh_token.length > 0
          ? body.refresh_token
          : refreshToken;
      const expiresIn =
        typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
          ? body.expires_in
          : undefined;
      const expiresAtFromBody = tokenExpiresAt(body.expires_at);
      const nextExpiresAt =
        expiresAtFromBody ?? (expiresIn === undefined ? undefined : now() + expiresIn * 1000);

      const latestCredentialsJson = await currentCredentialsJson();
      // Clearing the durable source while the request is in flight is logout.
      // Never resurrect the old account from the request-local snapshot.
      if (latestCredentialsJson === undefined) return undefined;
      const latestCredentials = parseCredentialsJson(latestCredentialsJson);
      if (latestCredentials === undefined) return undefined;
      const latestOauth = latestCredentials.claudeAiOauth ?? {};
      // A login can replace the account credentials while this network request
      // is in flight outside the embedded coordinator. Its newer refresh token
      // must never be overwritten by a response obtained with the old one.
      if (latestOauth.refreshToken !== refreshToken) {
        return typeof latestOauth.accessToken === 'string' && latestOauth.accessToken.length > 0
          ? latestOauth.accessToken
          : undefined;
      }
      const sourceJson = latestCredentialsJson ?? providedCredentialsJson;
      latestCredentials.claudeAiOauth = {
        ...latestOauth,
        accessToken: body.access_token,
        refreshToken: nextRefreshToken,
        ...(nextExpiresAt === undefined ? {} : { expiresAt: nextExpiresAt }),
      };
      pendingCredentials = {
        json: stringifyCredentials(latestCredentials),
        parsed: latestCredentials,
        accessToken: body.access_token,
        sourceJson,
      };
      // Deliberately outside the ordinary refresh-failure fallback semantics: if
      // this throws, callers see the persistence failure and the next call retries
      // the retained rotated bundle without redeeming the old token again.
      await persistPendingCredentials();
      return body.access_token;
    } catch (error) {
      if (pendingCredentials !== undefined) throw error;
      return fallbackUsableToken();
    }
  };

  const provider: ClaudeOAuthTokenProvider = (): Promise<string | undefined> => {
    // Refresh tokens rotate. Every consumer of this provider must share one
    // refresh attempt so concurrent session starts cannot redeem the same token
    // twice and invalidate the credentials for the losing process.
    if (inFlight !== undefined) return inFlight;
    const pending = resolveToken();
    const shared = pending.finally(() => {
      if (inFlight === shared) inFlight = undefined;
    });
    inFlight = shared;
    return inFlight;
  };
  provider.discardPendingCredentials = () => {
    pendingCredentials = undefined;
  };
  return provider;
}

/**
 * Build the singleton Claude usage probe. Lazy + cached + backing off per the
 * endpoint's brutal rate limiting (see the file header). Safe to call `getLimits()`
 * on every overview request — it only reaches Anthropic when the cache is stale and
 * no backoff is pending, dedupes concurrent refreshes, and otherwise returns the
 * last-good value.
 */
export function createClaudeUsageService(opts: ClaudeUsageOptions = {}): ClaudeUsageService {
  const token = opts.token;
  const tokenProvider = opts.tokenProvider;
  const log = opts.log ?? NOOP_LOGGER;
  const doFetch =
    opts.fetch ??
    (typeof globalThis.fetch === 'function'
      ? (url, init) => globalThis.fetch(url, init)
      : undefined);
  const now = opts.now ?? Date.now;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const minRetryMs = opts.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  // Last successful reading and when it was taken; the backoff deadline + step; and
  // the in-flight refresh (so concurrent callers share one request).
  let cached: RateLimitState[] = [];
  let fetchedAt = 0;
  let hasReading = false;
  let nextAttemptAt = 0;
  let backoffMs = minRetryMs;
  let inflight: Promise<void> | null = null;

  function backOff(): void {
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    nextAttemptAt = now() + backoffMs;
  }

  async function refresh(): Promise<void> {
    if (!doFetch) return;
    try {
      const activeToken = token ?? (await tokenProvider?.());
      if (!activeToken) {
        // No resolvable OAuth token: sealed settings store, unconfigured account,
        // or an expired credential that couldn't refresh. Codex is unaffected (it
        // needs no server-side secret), so this is the usual "Claude meter empty".
        log.warn(
          { reason: 'no-token' },
          'verity: claude usage probe has no OAuth token; meter stays empty',
        );
        backOff();
        return;
      }
      const res = await doFetch(USAGE_URL, {
        headers: {
          authorization: `Bearer ${activeToken}`,
          'anthropic-beta': OAUTH_BETA,
          'user-agent': userAgent,
          'content-type': 'application/json',
        },
      });
      if (!res.ok) {
        // 429 (rate-limited, the common case), or 401/403 (token rejected/wrong
        // scope), or any other non-2xx: back off, keep last-good. The status
        // distinguishes a transient limit from a bad credential.
        log.warn(
          { reason: 'non-2xx', status: res.status },
          'verity: claude usage probe returned non-2xx; backing off',
        );
        backOff();
        return;
      }
      const observedAt = now();
      const states = parseClaudeUsage(await res.json(), observedAt);
      cached = states;
      fetchedAt = observedAt;
      hasReading = true;
      backoffMs = minRetryMs;
      nextAttemptAt = 0;
      if (states.length === 0) {
        // 2xx but nothing parsed: the undocumented response shape likely changed
        // (fields no longer `utilization`/`resets_at`), or the account genuinely
        // has no active windows. Either way the meter shows empty — flag it.
        log.warn(
          { reason: 'empty-parse' },
          'verity: claude usage probe returned 2xx but parsed no windows',
        );
      } else {
        log.debug({ windows: states.length }, 'verity: claude usage probe refreshed');
      }
    } catch {
      // Network/parse failure: identical backoff, serve last-good.
      log.warn({ reason: 'exception' }, 'verity: claude usage probe threw; backing off');
      backOff();
    }
  }

  return {
    async getLimits(): Promise<RateLimitState[]> {
      if ((!token && !tokenProvider) || !doFetch) return [];
      const t = now();
      const fresh = hasReading && t - fetchedAt < ttlMs;
      const backingOff = t < nextAttemptAt;
      if (!fresh && !backingOff) {
        // Refresh once for concurrent callers; failures never propagate.
        inflight ??= refresh().finally(() => {
          inflight = null;
        });
        await inflight;
      }
      return cached;
    },
  };
}
