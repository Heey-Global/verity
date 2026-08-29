import type { AgentEvent, RateLimitWindow, Usage } from './events.js';

/** Cumulative token usage across a session's turns (§13a quota math). */
export interface UsageTotals extends Usage {
  /** Number of completed turns (`result` events) that contributed usage. */
  turns: number;
}

/** Latest provider/window rate-limit state observed in a session log. */
export interface RateLimitState {
  status: string;
  resetsAt: number;
  window: RateLimitWindow;
  usedPercent?: number;
  /** Provider-defined quota scope. Omitted by older states means all models. */
  scope?: string;
  providerLabel: string;
  /** Epoch milliseconds when this quota state was observed by Verity. */
  observedAt?: number;
}

/** Codex reports a quota window by its length in minutes. */
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;

/**
 * Map a Codex quota window length onto the canonical window. Codex names its two
 * windows only positionally (`primary`/`secondary`) and identifies them by length,
 * and the plan decides which lengths exist — a weekly-only plan reports the weekly
 * cap as `primary`, so the position alone is not enough. Anything unrecognized
 * falls back to the position's conventional meaning.
 *
 * Shared because two readers speak this wire shape: the rollout parser in the
 * session backend and the server-side `/wham/usage` probe. They must not drift.
 */
export function codexRateLimitWindow(
  windowMinutes: number | undefined,
  fallback: RateLimitWindow,
): RateLimitWindow {
  if (windowMinutes === WEEKLY_WINDOW_MINUTES) return 'weekly';
  if (windowMinutes === FIVE_HOUR_WINDOW_MINUTES) return 'five_hour';
  return fallback;
}

/**
 * Whether a Codex window is exhausted rather than merely consumed. `used_percent`
 * at/over 100 is decisive on its own; otherwise Codex flags the blocked window in
 * `rate_limit_reached_type`, whose value names it either positionally or by length.
 */
export function codexRateLimitReached(
  reachedType: string | undefined,
  field: 'primary' | 'secondary',
  window: RateLimitWindow,
  usedPercent: number,
): boolean {
  if (usedPercent >= 100) return true;
  if (reachedType === undefined) return false;
  const normalized = reachedType.toLowerCase();
  if (field === 'primary' && /\bprimary\b/.test(normalized)) return true;
  if (field === 'secondary' && /\bsecondary\b/.test(normalized)) return true;
  if (window === 'five_hour' && /\bfive[_ -]?hour|5[_ -]?hour\b/.test(normalized)) return true;
  return window === 'weekly' && /\bweekly|week\b/.test(normalized);
}

/**
 * Sum token usage across a session's `result` events — one per completed turn
 * (§13a). A read-time projection over the canonical log, mirroring the
 * read-time status projection; the same scaling note applies (O(events)/request,
 * fine for the single-operator v1 — a store-side SUM over the JSONB payload is
 * the eventual path when this grows).
 */
export function aggregateUsage(events: readonly AgentEvent[]): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 0,
  };
  for (const event of events) {
    if (event.t !== 'result') continue;
    totals.inputTokens += event.usage.inputTokens;
    totals.outputTokens += event.usage.outputTokens;
    totals.cacheReadTokens += event.usage.cacheReadTokens;
    totals.cacheCreationTokens += event.usage.cacheCreationTokens;
    totals.turns += 1;
  }
  return totals;
}

/** Return the latest provider/window limit states from a session log. */
export function latestRateLimits(events: readonly AgentEvent[]): RateLimitState[] {
  const seenLimits = new Set<string>();
  const latest: RateLimitState[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.t === 'rate_limit') {
      const providerLabel = event.providerLabel ?? 'Claude';
      const key = `${providerLabel}\0${event.window}\0${event.scope ?? 'all_models'}`;
      if (seenLimits.has(key)) continue;
      seenLimits.add(key);
      if (event.status === 'allowed' && event.usedPercent === undefined) continue;
      latest.push({
        status: event.status,
        resetsAt: event.resetsAt,
        window: event.window,
        ...(event.usedPercent !== undefined ? { usedPercent: event.usedPercent } : {}),
        ...(event.scope !== undefined ? { scope: event.scope } : {}),
        providerLabel,
      });
    }
  }
  return latest.sort((a, b) => {
    const activeDelta = Number(a.status === 'allowed') - Number(b.status === 'allowed');
    if (activeDelta !== 0) return activeDelta;
    return b.resetsAt - a.resetsAt;
  });
}

/** Return the active provider limit with the latest reset, if any. */
export function latestRateLimit(events: readonly AgentEvent[]): RateLimitState | undefined {
  return latestRateLimits(events)[0];
}
