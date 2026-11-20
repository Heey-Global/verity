import type { HttpResponse } from './github.js';

/** Bounded observations; an active recovery probe must keep its shared identity. */
export class GitHubPollCache<K, V> extends Map<K, V> {
  constructor(
    private readonly limit = 512,
    private readonly pinned: (value: V) => boolean = () => false,
  ) {
    super();
  }

  override set(key: K, value: V): this {
    while (!this.has(key) && this.size >= this.limit) {
      const candidate = [...this].find(([, previous]) => !this.pinned(previous));
      // Active probes may temporarily overflow; losing their identity starts duplicates.
      if (!candidate) break;
      this.delete(candidate[0]);
    }
    return super.set(key, value);
  }
}

/** Preserve a provider deadline rather than retrying a rate-limited request each minute. */
export function githubRetryDeadline(response: HttpResponse, now: number): number {
  if (response.ok) return 0;
  const retry = response.headers?.get('retry-after');
  const seconds = retry === null || retry === undefined ? NaN : Number(retry);
  const retryAt = Number.isFinite(seconds)
    ? now + Math.max(0, seconds) * 1000
    : retry
      ? Date.parse(retry)
      : 0;
  const limited =
    response.status === 429 ||
    (response.status === 403 && response.headers?.get('x-ratelimit-remaining') === '0');
  const reset = Number(response.headers?.get('x-ratelimit-reset')) * 1000;
  return Math.max(
    limited ? now + 60_000 : 0,
    Number.isFinite(retryAt) ? retryAt : 0,
    limited && Number.isFinite(reset) ? reset : 0,
  );
}

export interface GitHubPollingCooldown {
  until: number;
  inFlight?: Promise<void>;
  tokenRead?: Promise<string | undefined>;
  tokenUntil?: number;
}

/** A token-broker outage is shared before a credential identity is available. */
export function readGitHubPollingToken(
  state: GitHubPollingCooldown,
  load: () => Promise<string | undefined>,
  now: () => number,
  backoffMs: number,
): Promise<string | undefined> {
  if (now() < (state.tokenUntil ?? 0)) return Promise.resolve(undefined);
  if (state.tokenRead) return state.tokenRead;
  const pending = Promise.resolve()
    .then(load)
    .catch(() => undefined)
    .then((token) => {
      if (token === undefined) state.tokenUntil = now() + backoffMs;
      else delete state.tokenUntil;
      return token;
    })
    .finally(() => {
      if (state.tokenRead === pending) delete state.tokenRead;
    });
  state.tokenRead = pending;
  return pending;
}
