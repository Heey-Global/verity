/**
 * Rate-limit banner gating (pure -> unit-testable). The session screen shows a
 * single banner ABOVE the input only when the provider quota window is not
 * `allowed`, with the reset time — instead of a per-turn transcript row.
 *
 * Providers distinguish "running low" from "exhausted" (Claude sends
 * `allowed_warning` from ~90% before it sends `rejected`), so the notice carries
 * a {@link RateLimitLevel}: a `warning` window still accepts turns and must not
 * read as, or gate the UI like, a reached limit.
 */
export type RateLimitWindow = 'five_hour' | 'weekly';

export interface RateLimit {
  status: string;
  /** Epoch SECONDS at which the quota window resets. */
  resetsAt: number;
  /** Quota window. Older servers omit this; the client treats that as five-hour. */
  window?: RateLimitWindow | undefined;
  /** Optional quota usage percent, used by overview meter rows. */
  usedPercent?: number | undefined;
  /** Provider-defined quota scope. Omitted by older servers means all models. */
  scope?: string | undefined;
  /** Provider/engine label whose quota window this event describes. */
  providerLabel?: string | undefined;
  /** Epoch milliseconds when this quota state was observed by Verity. */
  observedAt?: number | undefined;
}

/**
 * How hard the quota window bites: `warning` means it is running low but still
 * usable, `blocked` means it is exhausted and turns are refused.
 */
export type RateLimitLevel = 'warning' | 'blocked';

export interface RateLimitNotice {
  resetsAt: number;
  window: RateLimitWindow;
  providerLabel: string;
  level: RateLimitLevel;
  /** Quota usage percent (0–100), when the provider reported one. */
  usedPercent?: number | undefined;
}

/**
 * How much of a quota window must be consumed before a `warning` status earns a
 * banner. Providers warn early — Claude flags `allowed_warning` from around half
 * a window — and a persistent banner two thirds of a week before anything
 * actually stops is alarm without information. An exhausted window is unaffected:
 * it always shows, whatever the percent says.
 *
 * Per window, because the same percent buys very different amounts of warning.
 * The last 5% of a week is still hours of work and days of banner, so the weekly
 * threshold sits high; the last 10% of a five-hour window is minutes, and a
 * banner that arrives any later than that cannot be acted on before the next
 * turn is refused. The five-hour figure is deliberately no lower: a short window
 * warned about at half full would show the banner for over two hours.
 */
export const RATE_LIMIT_WARNING_MIN_PERCENT: Record<RateLimitWindow, number> = {
  weekly: 95,
  five_hour: 90,
};

/**
 * How much of a quota window must be consumed before the overview meter tints
 * its bar — one figure for every window, since the meter shows them side by
 * side and a bar that changes colour at a different mark per row is unreadable.
 * At or below the lowest {@link RATE_LIMIT_WARNING_MIN_PERCENT}: the meter is a
 * gauge read on purpose, so it may hint no later than the banner, which
 * interrupts.
 *
 * Raised from the 85 the meter used inline before, so a bar that has tinted for
 * a while and a banner that has just appeared no longer tell two stories about
 * the same window.
 */
export const RATE_LIMIT_METER_WARNING_PERCENT = 90;

/**
 * How the overview meter should paint a quota bar: `calm` is the ordinary muted
 * bar, `low` tints it, `spent` is the reached-limit colour.
 */
export type QuotaMeterLevel = 'calm' | 'low' | 'spent';

/**
 * Meter level for a quota state. Percent decides the tint whatever the status
 * says, so a window the provider still calls `allowed` tints once it crosses
 * {@link RATE_LIMIT_METER_WARNING_PERCENT}, and one it warns about early stays
 * calm until it gets there.
 *
 * The exception is a warning the provider sent without a usable percent: there
 * is no bar length to judge, so the tint follows the provider. That keeps the
 * meter consistent with {@link rateLimitNotice}, which speaks up in exactly that
 * case.
 */
export function quotaMeterLevel(rateLimit: RateLimit | null | undefined): QuotaMeterLevel {
  if (!rateLimit) return 'calm';
  if (rateLimit.status !== 'allowed' && rateLimit.status !== 'allowed_warning') return 'spent';
  const percent = rateLimit.usedPercent;
  if (percent === undefined || !Number.isFinite(percent)) {
    return rateLimit.status === 'allowed_warning' ? 'low' : 'calm';
  }
  return percent >= RATE_LIMIT_METER_WARNING_PERCENT ? 'low' : 'calm';
}

/**
 * Whether to show the rate-limit banner and, if so, the reset epoch to display.
 * Returns null when there's no rate-limit state yet or the window is `allowed`
 * (the common case — no banner). Only `allowed_warning` is a `warning`; every
 * other non-`allowed` status is treated as `blocked`, so an unknown status from
 * a newer server stays on the safe side.
 *
 * A warning window is additionally held back until it has consumed its window's
 * {@link RATE_LIMIT_WARNING_MIN_PERCENT}. A warning without a reported percent
 * still shows: it is the only signal we have, and no provider we read sends one
 * early without a number.
 */
export function rateLimitNotice(
  rateLimit: RateLimit | undefined,
  nowMs = Date.now(),
): RateLimitNotice | null {
  if (!rateLimit || rateLimit.status === 'allowed') return null;
  if (rateLimit.resetsAt <= Math.floor(nowMs / 1000)) return null;
  const window = rateLimit.window ?? 'five_hour';
  if (
    rateLimit.status === 'allowed_warning' &&
    !warningWorthShowing(rateLimit.usedPercent, window)
  ) {
    return null;
  }
  return {
    resetsAt: rateLimit.resetsAt,
    window,
    providerLabel: rateLimit.providerLabel ?? 'Claude',
    level: rateLimit.status === 'allowed_warning' ? 'warning' : 'blocked',
    ...(rateLimit.usedPercent === undefined ? {} : { usedPercent: rateLimit.usedPercent }),
  };
}

/** A percent that is missing or garbled cannot be judged against the threshold. */
function warningWorthShowing(usedPercent: number | undefined, window: RateLimitWindow): boolean {
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return true;
  return usedPercent >= RATE_LIMIT_WARNING_MIN_PERCENT[window];
}

/**
 * Banner copy for a notice. Takes the already-formatted reset label — a clock
 * time, or a weekday and clock time for a weekly window — so the wording stays
 * testable without pulling locale formatting in here.
 *
 * A warning percent is floored rather than rounded, so 99.6 does not describe a
 * window that still accepts turns as a full one. A percent that is missing,
 * non-finite, or already at 100 on a warning window is self-contradictory, so it
 * drops to the wordy branch instead of printing a number that would be wrong.
 */
export function rateLimitNoticeText(notice: RateLimitNotice, resetClock: string): string {
  const window = rateLimitWindowLabel(notice.window);
  const reset = `resets at ${resetClock}`;
  if (notice.level === 'blocked') {
    return `${notice.providerLabel} ${window} limit reached — ${reset}`;
  }
  const percent = notice.usedPercent;
  const showsPercent = percent !== undefined && Number.isFinite(percent) && percent < 100;
  const used = showsPercent ? `at ${Math.max(0, Math.floor(percent))}%` : 'running low';
  return `${notice.providerLabel} ${window} quota ${used} — ${reset}`;
}

/**
 * Banner tone for a notice: a warning window still accepts turns and stays at
 * `attention`, an exhausted one escalates to `danger`.
 */
export function rateLimitNoticeTone(notice: RateLimitNotice): 'attention' | 'danger' {
  return notice.level === 'warning' ? 'attention' : 'danger';
}

/**
 * Whether the model picker locks a model out. Only an exhausted quota does —
 * a warning window is still usable, and its provider's models stay selectable.
 */
export function modelRateLimited(
  notice: RateLimitNotice | null | undefined,
  modelEngine: string,
): boolean {
  return notice?.level === 'blocked' && notice.providerLabel === modelEngine;
}

export function rateLimitWindowLabel(window: RateLimitWindow): string {
  return window === 'weekly' ? 'weekly' : '5-hour';
}

/** Length of the five-hour quota window, in seconds. */
export const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;

/** Length of the weekly quota window, in seconds (7 days). */
export const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/** Total length of a quota window, in seconds. */
function windowSeconds(window: RateLimitWindow): number {
  return window === 'weekly' ? WEEKLY_WINDOW_SECONDS : FIVE_HOUR_WINDOW_SECONDS;
}

/**
 * Even-burn "pace" for a quota window: the fraction of the window that has
 * already elapsed, expressed as a percent (0–100). Overlaying this on the used
 * bar shows at a glance whether consumption is ahead of (bar past the line → at
 * risk) or behind (bar short of the line → on track) a steady rate. Applies to
 * both the five-hour and weekly windows.
 *
 * `resetsAt` marks the window's end, so the window started `windowSeconds`
 * earlier and the elapsed fraction is `1 − (resetsAt − now) / windowSeconds`.
 *
 * Five-hour reset labels deliberately show only a clock time. Some providers
 * attach the wrong calendar day to that time, so for this short window we use
 * the next occurrence of the reported clock time when the raw timestamp lies
 * more than five hours ahead. Thus, at 17:00, a reported 21:00 is interpreted
 * as today while 02:00 is interpreted as tomorrow.
 *
 * Returns null only when there is nothing to draw: non-finite input, or a reset
 * already reached (the window is over/stale). Otherwise the result is clamped
 * into [0, 100].
 */
export function pacePercent(
  resetsAtSeconds: number,
  window: RateLimitWindow,
  nowMs = Date.now(),
): number | null {
  if (!Number.isFinite(resetsAtSeconds)) return null;
  const nowSeconds = nowMs / 1000;
  // Reset reached or in the past: the window is over/stale, nothing to pace.
  if (resetsAtSeconds <= nowSeconds) return null;
  const total = windowSeconds(window);
  let effectiveResetAt = resetsAtSeconds;
  if (window === 'five_hour' && resetsAtSeconds - nowSeconds > total) {
    const reportedReset = new Date(resetsAtSeconds * 1000);
    const nextClockOccurrence = new Date(nowMs);
    nextClockOccurrence.setHours(
      reportedReset.getHours(),
      reportedReset.getMinutes(),
      reportedReset.getSeconds(),
      0,
    );
    if (nextClockOccurrence.getTime() <= nowMs) {
      nextClockOccurrence.setDate(nextClockOccurrence.getDate() + 1);
    }
    effectiveResetAt = nextClockOccurrence.getTime() / 1000;
  }
  const elapsed = total - (effectiveResetAt - nowSeconds);
  const percent = (elapsed / total) * 100;
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, percent));
}
