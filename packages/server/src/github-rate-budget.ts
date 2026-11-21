/**
 * Installation-wide view of GitHub's REST rate limits.
 *
 * Every Verity reader of a GitHub account (PR status, repository discovery, QA
 * analysis, releases) spends the same App-installation quota, but each reader used
 * to keep its own per-repository cooldown. One exhausted reader therefore taught
 * nobody else, and background polling kept spending what agents needed. This
 * module observes the rate-limit headers of every response, holds a shared lock
 * while the quota or a secondary limit is exhausted, and tells background readers
 * to step aside while the remaining quota is low. It also keeps bounded,
 * credential-free counters so a reported limit can be attributed afterwards.
 *
 * Only read responses update quota state: writes may use other credentials (for
 * example a person's token creating a pull request) whose limits are separate.
 * State is keyed by repository owner, which matches one App installation per
 * account. A personal-access-token override spends one quota across owners, so
 * in that mode the per-owner lock protects less than the whole quota.
 */

export const GITHUB_CALLER_CATEGORIES = [
  'session-status',
  'repository-status',
  'discovery',
  'qa-analysis',
  'release',
  'other',
] as const;
export type GitHubCallerCategory = (typeof GITHUB_CALLER_CATEGORIES)[number];

/** Background readers pause below this share of the remaining primary quota. */
const BACKGROUND_QUOTA_FLOOR = 0.2;
const SECONDARY_MIN_MS = 60_000;
const SECONDARY_MAX_MS = 15 * 60_000;
const PRIMARY_FALLBACK_MS = 60_000;
const MAX_LOCK_MS = 60 * 60_000;
const WINDOW_MINUTES = 60;
const MAX_EVENTS = 20;
const MAX_ACCOUNTS = 256;
const LOG_INTERVAL_MS = 60_000;

type GitHubLimitKind = 'primary' | 'secondary';

export interface GitHubLimitEvent {
  at: string;
  category: GitHubCallerCategory;
  kind: GitHubLimitKind;
  status: number;
  account: string;
  repo?: string;
  endpoint: string;
  resource: string;
  retryAt: string;
}

interface QuotaState {
  limit?: number | undefined;
  remaining?: number | undefined;
  used?: number | undefined;
  resetAt?: number | undefined;
  observedAt: number;
  lockedUntil: number;
  lockKind?: GitHubLimitKind;
  secondaryStreak: number;
}

interface Counts {
  requests: number;
  notModified: number;
  limited: number;
  suppressed: number;
}

export interface GitHubRateSnapshot {
  observedAt: string;
  windowMinutes: number;
  categories: Record<GitHubCallerCategory, Counts>;
  quotas: {
    account: string;
    resource: string;
    limit: number | null;
    remaining: number | null;
    used: number | null;
    resetAt: string | null;
    observedAt: string;
    lockedUntil: string | null;
    lockKind: GitHubLimitKind | null;
  }[];
  events: GitHubLimitEvent[];
}

interface HeaderSource {
  get(name: string): string | null;
}

export interface GitHubObservation {
  url: string;
  category: GitHubCallerCategory;
  status: number;
  headers?: HeaderSource | undefined;
  /** The response body, read only for a 403 without explicit limit headers. */
  bodyText?: string | undefined;
  /** False for writes, whose credential may not share the installation quota. */
  quota?: boolean | undefined;
}

interface Target {
  account: string;
  repo?: string;
  resource: string;
  endpoint: string;
}

/** Owner, repository and a coarse endpoint class; never the query or credential. */
export function githubRequestTarget(url: string | URL): Target | undefined {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== 'api.github.com') return undefined;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const resource = parts[0] === 'search' ? 'search' : parts[0] === 'graphql' ? 'graphql' : 'core';
  if (parts[0] !== 'repos' || parts.length < 3)
    return { account: '(installation)', resource, endpoint: parts[0] ?? 'root' };
  const rest = parts.slice(3);
  const endpoint =
    rest.length === 0
      ? 'repository'
      : rest[0] === 'commits' && rest[2] !== undefined
        ? rest[2]
        : rest[0]!;
  const decode = (segment: string) => {
    try {
      return decodeURIComponent(segment).toLowerCase();
    } catch {
      return segment.toLowerCase();
    }
  };
  return {
    account: decode(parts[1]!),
    repo: decode(parts[2]!),
    resource,
    endpoint: /^[a-z_-]{1,40}$/u.test(endpoint) ? endpoint : 'other',
  };
}

const header = (headers: HeaderSource | undefined, name: string): string | null => {
  try {
    return headers?.get(name) ?? null;
  } catch {
    return null;
  }
};

const numeric = (value: string | null): number | undefined => {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const seconds = numeric(value);
  if (seconds !== undefined) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** GitHub documents this wording for secondary limits that arrive without Retry-After. */
const SECONDARY_MESSAGE = /secondary rate limit|abuse detection/iu;

export function createGitHubRateBudget(
  opts: {
    now?: () => number;
    onLimit?: (event: GitHubLimitEvent) => void;
  } = {},
) {
  const now = opts.now ?? Date.now;
  const quotas = new Map<string, QuotaState>();
  const buckets: { minute: number; counts: Record<GitHubCallerCategory, Counts> }[] = [];
  const events: GitHubLimitEvent[] = [];
  const lastLogged = new Map<string, number>();

  const quotaKey = (account: string, resource: string) => `${account}\0${resource}`;
  const quotaFor = (account: string, resource: string): QuotaState => {
    const key = quotaKey(account, resource);
    let state = quotas.get(key);
    // Re-insert on every observation so eviction drops the least recently seen account.
    if (state) {
      quotas.delete(key);
      quotas.set(key, state);
    } else {
      // An active lock is the only thing stopping an exhausted account; never evict
      // it. Evict before inserting so the new account cannot evict itself.
      while (quotas.size >= MAX_ACCOUNTS) {
        const idle = [...quotas].find(([, entry]) => entry.lockedUntil <= now());
        if (!idle) break;
        quotas.delete(idle[0]);
      }
      state = { observedAt: now(), lockedUntil: 0, secondaryStreak: 0 };
      quotas.set(key, state);
    }
    return state;
  };
  const count = (category: GitHubCallerCategory, field: keyof Counts) => {
    const minute = Math.floor(now() / 60_000);
    let bucket = buckets.at(-1);
    if (!bucket || bucket.minute !== minute) {
      const counts = Object.fromEntries(
        GITHUB_CALLER_CATEGORIES.map((name) => [
          name,
          { requests: 0, notModified: 0, limited: 0, suppressed: 0 },
        ]),
      ) as Record<GitHubCallerCategory, Counts>;
      bucket = { minute, counts };
      buckets.push(bucket);
    }
    while (buckets.length > 0 && buckets[0]!.minute <= minute - WINDOW_MINUTES) buckets.shift();
    bucket.counts[category][field] += 1;
  };
  const record = (event: GitHubLimitEvent) => {
    events.push(event);
    while (events.length > MAX_EVENTS) events.shift();
    const last = lastLogged.get(event.account) ?? -Infinity;
    if (now() - last < LOG_INTERVAL_MS) return;
    lastLogged.set(event.account, now());
    while (lastLogged.size > MAX_ACCOUNTS) lastLogged.delete(lastLogged.keys().next().value!);
    try {
      opts.onLimit?.(event);
    } catch {
      // Telemetry must never change the outcome of a GitHub read.
    }
  };

  return {
    /** Epoch ms until which requests for this URL must not be sent; 0 when open. */
    lockedUntil(url: string | URL): number {
      const target = githubRequestTarget(url);
      // Non-repository endpoints cannot be tied to one installation's quota.
      if (target?.repo === undefined) return 0;
      const state = quotas.get(quotaKey(target.account, target.resource));
      return state && state.lockedUntil > now() ? state.lockedUntil : 0;
    },
    /** Background readers step aside near exhaustion so agents and open apps keep quota. */
    deferBackground(account: string): boolean {
      const state = quotas.get(quotaKey(account.toLowerCase(), 'core'));
      if (!state) return false;
      if (state.lockedUntil > now()) return true;
      if (state.limit === undefined || state.remaining === undefined || state.limit <= 0)
        return false;
      if (state.resetAt !== undefined && state.resetAt <= now()) return false;
      return state.remaining / state.limit < BACKGROUND_QUOTA_FLOOR;
    },
    suppressed(category: GitHubCallerCategory): void {
      count(category, 'suppressed');
    },
    /** Whether a 403 needs its body inspected to classify a secondary limit. */
    needsBody(status: number, headers: HeaderSource | undefined): boolean {
      return (
        status === 403 &&
        header(headers, 'retry-after') === null &&
        header(headers, 'x-ratelimit-remaining') !== '0'
      );
    },
    observe(observation: GitHubObservation): void {
      const target = githubRequestTarget(observation.url);
      if (!target) return;
      const at = now();
      const { status, headers, category } = observation;
      count(category, status === 304 ? 'notModified' : 'requests');
      if (target.repo === undefined || observation.quota === false) return;
      // Keyed by the path-derived resource so the lock is enforced where it is read.
      const resource = target.resource;
      const state = quotaFor(target.account, resource);
      const limit = numeric(header(headers, 'x-ratelimit-limit'));
      const remaining = numeric(header(headers, 'x-ratelimit-remaining'));
      const used = numeric(header(headers, 'x-ratelimit-used'));
      const reset = numeric(header(headers, 'x-ratelimit-reset'));
      if (remaining !== undefined) {
        state.limit = limit;
        state.remaining = remaining;
        state.used = used;
        state.resetAt = reset === undefined ? undefined : reset * 1000;
        state.observedAt = at;
      }
      const retry = retryAfterMs(header(headers, 'retry-after'), at);
      const primary = remaining === 0;
      const secondary =
        !primary &&
        (status === 429 ||
          (status === 403 &&
            (retry !== undefined || SECONDARY_MESSAGE.test(observation.bodyText ?? ''))));
      if (!primary && !secondary) {
        if (status < 400) state.secondaryStreak = 0;
        return;
      }
      let until: number;
      let kind: GitHubLimitKind;
      if (primary) {
        kind = 'primary';
        until = Math.max(
          retry === undefined ? 0 : at + retry,
          // A reset already in the past (clock skew) must still hold a short lock.
          state.resetAt !== undefined && state.resetAt > at
            ? state.resetAt
            : at + PRIMARY_FALLBACK_MS,
        );
      } else {
        kind = 'secondary';
        state.secondaryStreak += 1;
        const backoff = Math.min(
          SECONDARY_MAX_MS,
          SECONDARY_MIN_MS * 2 ** Math.min(state.secondaryStreak - 1, 8),
        );
        until = at + Math.max(retry ?? 0, backoff);
      }
      until = Math.min(until, at + MAX_LOCK_MS);
      // A 200 that spends the last request is not a rejection; only a rejected
      // response is counted and reported as a limit event.
      if (status >= 400) count(category, 'limited');
      if (status >= 400 && state.lockedUntil < until)
        record({
          at: new Date(at).toISOString(),
          category,
          kind,
          status,
          account: target.account,
          ...(target.repo === undefined ? {} : { repo: target.repo }),
          endpoint: target.endpoint,
          resource,
          retryAt: new Date(until).toISOString(),
        });
      if (until > state.lockedUntil) {
        state.lockedUntil = until;
        state.lockKind = kind;
      }
    },
    snapshot(): GitHubRateSnapshot {
      const at = now();
      const minute = Math.floor(at / 60_000);
      const categories = Object.fromEntries(
        GITHUB_CALLER_CATEGORIES.map((name) => [
          name,
          { requests: 0, notModified: 0, limited: 0, suppressed: 0 },
        ]),
      ) as Record<GitHubCallerCategory, Counts>;
      for (const bucket of buckets) {
        if (bucket.minute <= minute - WINDOW_MINUTES) continue;
        for (const name of GITHUB_CALLER_CATEGORIES)
          for (const field of ['requests', 'notModified', 'limited', 'suppressed'] as const)
            categories[name][field] += bucket.counts[name][field];
      }
      const iso = (value: number | undefined) =>
        value === undefined ? null : new Date(value).toISOString();
      return {
        observedAt: new Date(at).toISOString(),
        windowMinutes: WINDOW_MINUTES,
        categories,
        quotas: [...quotas].slice(-MAX_ACCOUNTS).map(([key, state]) => {
          const [account, resource] = key.split('\0') as [string, string];
          return {
            account,
            resource,
            limit: state.limit ?? null,
            remaining: state.remaining ?? null,
            used: state.used ?? null,
            resetAt: iso(state.resetAt),
            observedAt: new Date(state.observedAt).toISOString(),
            lockedUntil: state.lockedUntil > at ? iso(state.lockedUntil) : null,
            lockKind: state.lockedUntil > at ? (state.lockKind ?? null) : null,
          };
        }),
        events: events.map((event) => ({ ...event })),
      };
    },
  };
}

export type GitHubRateBudget = ReturnType<typeof createGitHubRateBudget>;

interface TrackableResponse {
  status: number;
  headers?: HeaderSource | undefined;
}

/**
 * Wrap a fetch so every GitHub response feeds the shared budget, and a request
 * the installation cannot currently afford is answered locally with 429 and
 * Retry-After. Callers already treat that answer as a rate limit, so their own
 * cooldowns and observation errors keep working unchanged.
 */
export function trackGitHubFetch<
  F extends (url: never, init?: never) => Promise<TrackableResponse>,
>(budget: GitHubRateBudget, category: GitHubCallerCategory, base: F, now = Date.now): F {
  const tracked = async (url: string | URL, init?: unknown): Promise<TrackableResponse> => {
    const method = (init as { method?: string } | undefined)?.method?.toUpperCase() ?? 'GET';
    // Only reads yield to the lock. A user's merge or pull request must reach GitHub
    // and fail there, never be refused locally because background polling hit a limit.
    const reads = method === 'GET' || method === 'HEAD';
    const until = reads ? budget.lockedUntil(url) : 0;
    if (until > 0) {
      budget.suppressed(category);
      return new Response(null, {
        status: 429,
        headers: {
          'retry-after': String(Math.max(1, Math.ceil((until - now()) / 1000))),
          'x-verity-rate-budget': 'locked',
        },
      });
    }
    const response = await (
      base as unknown as (u: string | URL, i?: unknown) => Promise<TrackableResponse>
    )(url, init);
    let bodyText: string | undefined;
    if (budget.needsBody(response.status, response.headers)) {
      const clone = (response as { clone?: () => { text(): Promise<string> } }).clone;
      if (typeof clone === 'function') {
        bodyText = await clone
          .call(response)
          .text()
          .then((text) => text.slice(0, 2048))
          .catch(() => undefined);
      }
    }
    budget.observe({
      url: String(url),
      category,
      status: response.status,
      headers: response.headers,
      bodyText,
      quota: reads,
    });
    return response;
  };
  return tracked as unknown as F;
}
