// Unit tests for the reset-time formatter. The point of the change under test is
// that the clock format follows the device's 12/24-hour preference, so these lock
// down the `uses24hourClock` → format mapping and the "expo-localization threw"
// fallback (the formatter runs inline during render, so a throw must not crash).
// Assertions are timezone-independent: 24h output has no letters, 12h output has a
// day-period marker (AM/PM), regardless of the runner's local timezone.

// Jest hoists `jest.mock`; the factory may only close over `mock`-prefixed names.
let mockCalendars: Array<{ uses24hourClock: boolean | null }> = [{ uses24hourClock: null }];
let mockThrow = false;
jest.mock('expo-localization', () => ({
  getCalendars: () => {
    if (mockThrow) throw new Error('expo-localization unavailable');
    return mockCalendars;
  },
}));

import { formatClockTime, formatResetDisplay, formatTurnTimestamp } from '../lib/time';

// A fixed, arbitrary epoch (2023-11-14T22:13:20Z). The exact wall-clock hour is
// timezone-dependent, but the presence/absence of an AM/PM marker is not.
const EPOCH_SECONDS = 1_700_000_000;

beforeEach(() => {
  mockCalendars = [{ uses24hourClock: null }];
  mockThrow = false;
});

describe('formatClockTime', () => {
  it('uses 24-hour format when the device is set to 24h', () => {
    mockCalendars = [{ uses24hourClock: true }];
    const out = formatClockTime(EPOCH_SECONDS);
    expect(out).toMatch(/^\d{1,2}:\d{2}$/);
    expect(out).not.toMatch(/[a-z]/i);
  });

  it('uses 12-hour format when the device is set to 12h', () => {
    mockCalendars = [{ uses24hourClock: false }];
    expect(formatClockTime(EPOCH_SECONDS)).toMatch(/[a-z]/i);
  });

  it('falls back to the locale default when the preference is unknown', () => {
    mockCalendars = [{ uses24hourClock: null }];
    expect(formatClockTime(EPOCH_SECONDS)).not.toHaveLength(0);
  });

  it('does not throw when expo-localization is unavailable', () => {
    mockThrow = true;
    expect(() => formatClockTime(EPOCH_SECONDS)).not.toThrow();
    expect(formatClockTime(EPOCH_SECONDS)).not.toHaveLength(0);
  });
});

describe('formatResetDisplay', () => {
  it('includes the weekday for weekly resets but not five-hour resets', () => {
    mockCalendars = [{ uses24hourClock: true }];
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
      new Date(EPOCH_SECONDS * 1000).getDay()
    ];
    expect(formatResetDisplay(EPOCH_SECONDS, 'weekly')).toBe(
      `${weekday} ${formatClockTime(EPOCH_SECONDS)}`,
    );
    expect(formatResetDisplay(EPOCH_SECONDS, 'five_hour')).toBe(formatClockTime(EPOCH_SECONDS));
  });
});

describe('formatTurnTimestamp', () => {
  const EPOCH_MS = EPOCH_SECONDS * 1000;

  it('shows time only when the instant is on the current calendar day', () => {
    mockCalendars = [{ uses24hourClock: true }];
    // `now` is the same instant, so it is trivially the same local day in any tz.
    const out = formatTurnTimestamp(EPOCH_MS, new Date(EPOCH_MS));
    expect(out).toMatch(/^\d{1,2}:\d{2}$/);
  });

  it('prefixes a numeric day.month when the instant is an earlier day', () => {
    mockCalendars = [{ uses24hourClock: true }];
    // `now` is a week later — the message day differs regardless of timezone.
    const now = new Date(EPOCH_MS + 7 * 24 * 60 * 60 * 1000);
    expect(formatTurnTimestamp(EPOCH_MS, now)).toMatch(/^\d{2}\.\d{2}\. \d{1,2}:\d{2}$/);
  });

  it('honors the 12-hour device preference in the time part', () => {
    mockCalendars = [{ uses24hourClock: false }];
    expect(formatTurnTimestamp(EPOCH_MS, new Date(EPOCH_MS))).toMatch(/[a-z]/i);
  });
});
