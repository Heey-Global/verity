import { describe, expect, it } from 'vitest';
import {
  modelRateLimited,
  quotaMeterLevel,
  rateLimitNotice,
  rateLimitNoticeText,
  rateLimitNoticeTone,
  pacePercent,
  RATE_LIMIT_METER_WARNING_PERCENT,
  RATE_LIMIT_WARNING_MIN_PERCENT,
  WEEKLY_WINDOW_SECONDS,
  FIVE_HOUR_WINDOW_SECONDS,
} from './rateLimit.js';

describe('rateLimitNotice', () => {
  it('returns null when there is no rate-limit state yet', () => {
    expect(rateLimitNotice(undefined)).toBeNull();
  });

  it('returns null when the window is allowed (the common case — no banner)', () => {
    expect(rateLimitNotice({ status: 'allowed', resetsAt: 1_700_000_000 })).toBeNull();
  });

  it('surfaces the reset epoch when the window is not allowed', () => {
    expect(
      rateLimitNotice({ status: 'rejected', resetsAt: 1_700_000_000 }, 1_699_999_000_000),
    ).toEqual({
      resetsAt: 1_700_000_000,
      window: 'five_hour',
      providerLabel: 'Claude',
      level: 'blocked',
    });
  });

  it('reports allowed_warning as a warning, not a reached limit', () => {
    expect(
      rateLimitNotice(
        { status: 'allowed_warning', resetsAt: 42, window: 'weekly', usedPercent: 96.4 },
        41_000,
      ),
    ).toEqual({
      resetsAt: 42,
      window: 'weekly',
      providerLabel: 'Claude',
      level: 'warning',
      usedPercent: 96.4,
    });
  });

  it('holds a warning back until the window is nearly spent', () => {
    expect(
      rateLimitNotice(
        { status: 'allowed_warning', resetsAt: 42, window: 'weekly', usedPercent: 50 },
        41_000,
      ),
    ).toBeNull();
  });

  it('shows the warning exactly at the threshold', () => {
    expect(
      rateLimitNotice(
        {
          status: 'allowed_warning',
          resetsAt: 42,
          window: 'weekly',
          usedPercent: RATE_LIMIT_WARNING_MIN_PERCENT.weekly,
        },
        41_000,
      ),
    ).toMatchObject({ level: 'warning' });
  });

  // The discriminating percent: between the two thresholds, so the pair below
  // fails if they are ever swapped or collapsed back into one number.
  const BETWEEN_THRESHOLDS =
    (RATE_LIMIT_WARNING_MIN_PERCENT.five_hour + RATE_LIMIT_WARNING_MIN_PERCENT.weekly) / 2;

  it('speaks up for a five-hour window at a percent a week still keeps quiet about', () => {
    const warned = { status: 'allowed_warning', resetsAt: 42, usedPercent: BETWEEN_THRESHOLDS };
    expect(rateLimitNotice({ ...warned, window: 'five_hour' }, 41_000)).toMatchObject({
      level: 'warning',
    });
    expect(rateLimitNotice({ ...warned, window: 'weekly' }, 41_000)).toBeNull();
  });

  it('shows a five-hour warning exactly at its own threshold and not below it', () => {
    const warned = { status: 'allowed_warning', resetsAt: 42, window: 'five_hour' } as const;
    expect(
      rateLimitNotice({ ...warned, usedPercent: RATE_LIMIT_WARNING_MIN_PERCENT.five_hour }, 41_000),
    ).toMatchObject({ level: 'warning' });
    expect(
      rateLimitNotice(
        { ...warned, usedPercent: RATE_LIMIT_WARNING_MIN_PERCENT.five_hour - 0.1 },
        41_000,
      ),
    ).toBeNull();
  });

  it('treats a window the server left out as five-hour when holding a warning back', () => {
    expect(
      rateLimitNotice({ status: 'allowed_warning', resetsAt: 42, usedPercent: 50 }, 41_000),
    ).toBeNull();
    expect(
      rateLimitNotice(
        { status: 'allowed_warning', resetsAt: 42, usedPercent: BETWEEN_THRESHOLDS },
        41_000,
      ),
    ).toMatchObject({ level: 'warning', window: 'five_hour' });
  });

  it('holds back a warning reporting 0%, rather than reading it as missing', () => {
    expect(
      rateLimitNotice(
        { status: 'allowed_warning', resetsAt: 42, window: 'weekly', usedPercent: 0 },
        41_000,
      ),
    ).toBeNull();
  });

  it('never holds an exhausted window back, whatever percent it reports', () => {
    expect(
      rateLimitNotice({ status: 'rejected', resetsAt: 42, usedPercent: 12 }, 41_000),
    ).toMatchObject({ level: 'blocked' });
  });

  it('reports rejected as blocked', () => {
    expect(rateLimitNotice({ status: 'rejected', resetsAt: 42 }, 41_000)).toEqual({
      resetsAt: 42,
      window: 'five_hour',
      providerLabel: 'Claude',
      level: 'blocked',
    });
  });

  it('treats an unknown status as blocked rather than a warning', () => {
    expect(rateLimitNotice({ status: 'something_new', resetsAt: 42 }, 41_000)?.level).toBe(
      'blocked',
    );
  });

  it('keeps a reported 0% rather than dropping it as falsy', () => {
    expect(
      rateLimitNotice({ status: 'rejected', resetsAt: 42, usedPercent: 0 }, 41_000),
    ).toMatchObject({ level: 'blocked', usedPercent: 0 });
  });

  it('still speaks up for a warning the provider reported no percent for', () => {
    const notice = rateLimitNotice({ status: 'allowed_warning', resetsAt: 42 }, 41_000);
    expect(notice).toMatchObject({ level: 'warning' });
    expect(notice).not.toHaveProperty('usedPercent');
  });

  it('still speaks up for a warning whose percent is garbled', () => {
    expect(
      rateLimitNotice({ status: 'allowed_warning', resetsAt: 42, usedPercent: NaN }, 41_000),
    ).toMatchObject({ level: 'warning' });
  });

  it('uses the provider label and window from the rate-limit state', () => {
    expect(
      rateLimitNotice(
        { status: 'rejected', resetsAt: 42, window: 'weekly', providerLabel: 'Codex' },
        41_000,
      ),
    ).toEqual({
      resetsAt: 42,
      window: 'weekly',
      providerLabel: 'Codex',
      level: 'blocked',
    });
  });

  it('returns null once the reset time has passed', () => {
    expect(rateLimitNotice({ status: 'rejected', resetsAt: 42 }, 42_000)).toBeNull();
  });

  it('returns null for an expired warning window too', () => {
    expect(rateLimitNotice({ status: 'allowed_warning', resetsAt: 42 }, 42_000)).toBeNull();
  });
});

describe('quotaMeterLevel', () => {
  it('leaves the bar calm when there is nothing to show', () => {
    expect(quotaMeterLevel(null)).toBe('calm');
    expect(quotaMeterLevel(undefined)).toBe('calm');
  });

  it('stays calm for an early warning, which is where the panic used to start', () => {
    expect(quotaMeterLevel({ status: 'allowed_warning', resetsAt: 42, usedPercent: 50 })).toBe(
      'calm',
    );
  });

  it('tints from the meter threshold on, warning or not', () => {
    expect(
      quotaMeterLevel({
        status: 'allowed',
        resetsAt: 42,
        usedPercent: RATE_LIMIT_METER_WARNING_PERCENT,
      }),
    ).toBe('low');
    expect(
      quotaMeterLevel({
        status: 'allowed',
        resetsAt: 42,
        usedPercent: RATE_LIMIT_METER_WARNING_PERCENT - 0.1,
      }),
    ).toBe('calm');
  });

  it('follows the provider for a warning it gave no usable percent for', () => {
    expect(quotaMeterLevel({ status: 'allowed_warning', resetsAt: 42 })).toBe('low');
    expect(quotaMeterLevel({ status: 'allowed_warning', resetsAt: 42, usedPercent: NaN })).toBe(
      'low',
    );
  });

  it('leaves a percent-less allowed window calm', () => {
    expect(quotaMeterLevel({ status: 'allowed', resetsAt: 42 })).toBe('calm');
  });

  it('reports any other status as spent, whatever percent it carries', () => {
    expect(quotaMeterLevel({ status: 'rejected', resetsAt: 42, usedPercent: 12 })).toBe('spent');
    expect(quotaMeterLevel({ status: 'something_new', resetsAt: 42 })).toBe('spent');
  });

  it('never hints later than the banner interrupts, for any window', () => {
    for (const threshold of Object.values(RATE_LIMIT_WARNING_MIN_PERCENT)) {
      expect(RATE_LIMIT_METER_WARNING_PERCENT).toBeLessThanOrEqual(threshold);
    }
  });
});

describe('rateLimitNoticeText', () => {
  it('names the quota percent for a warning window', () => {
    expect(
      rateLimitNoticeText(
        {
          resetsAt: 42,
          window: 'weekly',
          providerLabel: 'Claude',
          level: 'warning',
          usedPercent: 97.6,
        },
        '14:00',
      ),
    ).toBe('Claude weekly quota at 97% — resets at 14:00');
  });

  it('never rounds a still-usable warning window up to 100%', () => {
    expect(
      rateLimitNoticeText(
        {
          resetsAt: 42,
          window: 'weekly',
          providerLabel: 'Claude',
          level: 'warning',
          usedPercent: 99.6,
        },
        '14:00',
      ),
    ).toBe('Claude weekly quota at 99% — resets at 14:00');
  });

  it('drops to words rather than claiming 100% on a window that still accepts turns', () => {
    expect(
      rateLimitNoticeText(
        {
          resetsAt: 42,
          window: 'weekly',
          providerLabel: 'Claude',
          level: 'warning',
          usedPercent: 100,
        },
        '14:00',
      ),
    ).toBe('Claude weekly quota running low — resets at 14:00');
  });

  it('falls back to "running low" rather than rendering a garbled percent', () => {
    expect(
      rateLimitNoticeText(
        {
          resetsAt: 42,
          window: 'weekly',
          providerLabel: 'Claude',
          level: 'warning',
          usedPercent: Number.NaN,
        },
        '14:00',
      ),
    ).toBe('Claude weekly quota running low — resets at 14:00');
  });

  it('falls back to "running low" when no percent was reported', () => {
    expect(
      rateLimitNoticeText(
        { resetsAt: 42, window: 'five_hour', providerLabel: 'Claude', level: 'warning' },
        '14:00',
      ),
    ).toBe('Claude 5-hour quota running low — resets at 14:00');
  });

  it('says the limit is reached only when blocked', () => {
    expect(
      rateLimitNoticeText(
        {
          resetsAt: 42,
          window: 'five_hour',
          providerLabel: 'Codex',
          level: 'blocked',
          usedPercent: 100,
        },
        '14:00',
      ),
    ).toBe('Codex 5-hour limit reached — resets at 14:00');
  });
});

describe('rateLimitNoticeTone', () => {
  const notice = (level: 'warning' | 'blocked') => ({
    resetsAt: 42,
    window: 'weekly' as const,
    providerLabel: 'Claude',
    level,
  });

  it('keeps a still-usable warning window at attention', () => {
    expect(rateLimitNoticeTone(notice('warning'))).toBe('attention');
  });

  it('escalates an exhausted window to danger', () => {
    expect(rateLimitNoticeTone(notice('blocked'))).toBe('danger');
  });
});

describe('modelRateLimited', () => {
  const notice = (level: 'warning' | 'blocked', providerLabel = 'Claude') => ({
    resetsAt: 42,
    window: 'weekly' as const,
    providerLabel,
    level,
  });

  it('locks out the provider whose quota is exhausted', () => {
    expect(modelRateLimited(notice('blocked'), 'Claude')).toBe(true);
  });

  it('keeps the provider selectable while its quota is only running low', () => {
    expect(modelRateLimited(notice('warning'), 'Claude')).toBe(false);
  });

  it('leaves another provider alone', () => {
    expect(modelRateLimited(notice('blocked'), 'Codex')).toBe(false);
  });

  it('locks nothing out without a notice', () => {
    expect(modelRateLimited(null, 'Claude')).toBe(false);
  });
});

describe('pacePercent', () => {
  // A window that resets exactly one week from `now`: 0% elapsed.
  const resetsAtFor = (elapsedSeconds: number, nowMs: number) =>
    Math.floor(nowMs / 1000) + (WEEKLY_WINDOW_SECONDS - elapsedSeconds);

  it('places the marker at 1/7 after one day of the week', () => {
    const now = 1_700_000_000_000;
    const oneDay = 24 * 60 * 60;
    const pace = pacePercent(resetsAtFor(oneDay, now), 'weekly', now);
    expect(pace).toBeCloseTo(100 / 7, 5);
  });

  it('places the marker near half-way after 3.5 days', () => {
    const now = 1_700_000_000_000;
    const pace = pacePercent(resetsAtFor(WEEKLY_WINDOW_SECONDS / 2, now), 'weekly', now);
    expect(pace).toBeCloseTo(50, 5);
  });

  it('paces the five-hour window against its 5-hour length', () => {
    const now = 1_700_000_000_000;
    // Reset one hour from now → 4 of 5 hours elapsed → 80%.
    const oneHour = 60 * 60;
    const resetsAt = Math.floor(now / 1000) + oneHour;
    expect(pacePercent(resetsAt, 'five_hour', now)).toBeCloseTo(80, 5);
  });

  it('places the five-hour marker at half-way after 2.5 hours', () => {
    const now = 1_700_000_000_000;
    const resetsAt = Math.floor(now / 1000) + FIVE_HOUR_WINDOW_SECONDS / 2;
    expect(pacePercent(resetsAt, 'five_hour', now)).toBeCloseTo(50, 5);
  });

  it('returns null once the reset has been reached (window over/stale)', () => {
    const now = 1_700_000_000_000;
    expect(pacePercent(resetsAtFor(WEEKLY_WINDOW_SECONDS, now), 'weekly', now)).toBeNull();
    expect(pacePercent(Math.floor(now / 1000), 'five_hour', now)).toBeNull();
    // A reset already in the past is stale, not paceable.
    expect(pacePercent(Math.floor(now / 1000) - 10, 'five_hour', now)).toBeNull();
  });

  it('clamps a just-started window to 0 rather than hiding its marker', () => {
    const now = 1_700_000_000_000;
    // Reset a full window away → 0% elapsed, but still drawn at the window start.
    expect(pacePercent(resetsAtFor(0, now), 'weekly', now)).toBe(0);
    expect(pacePercent(Math.floor(now / 1000) + FIVE_HOUR_WINDOW_SECONDS, 'five_hour', now)).toBe(
      0,
    );
  });

  it('uses the next occurrence of a five-hour reset clock when its date is too far ahead', () => {
    const now = new Date(2026, 6, 13, 17, 0, 0).getTime();
    // The raw timestamp incorrectly says tomorrow at 21:00. A five-hour reset
    // labelled 21:00 at 17:00 can only mean today, leaving four hours and placing
    // the marker at 20% elapsed.
    const resetsAt = new Date(2026, 6, 14, 21, 0, 0).getTime() / 1000;
    expect(pacePercent(resetsAt, 'five_hour', now)).toBeCloseTo(20, 5);
  });

  it('rolls an overnight five-hour reset clock into tomorrow', () => {
    const now = new Date(2026, 6, 13, 22, 0, 0).getTime();
    const resetsAt = new Date(2026, 6, 15, 2, 0, 0).getTime() / 1000;
    expect(pacePercent(resetsAt, 'five_hour', now)).toBeCloseTo(20, 5);
  });

  it('returns null for non-finite reset input', () => {
    expect(pacePercent(Number.NaN, 'weekly', 1_700_000_000_000)).toBeNull();
  });
});
