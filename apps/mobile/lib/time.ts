import { getCalendars } from 'expo-localization';

// Whether the device is configured for 24-hour time, as `hour12` for
// `toLocaleTimeString`: `false` → 24h, `true` → 12h, `undefined` → let the
// locale decide (the device preference is unknown). Read live on each call so a
// mid-session change in the OS clock setting is reflected without a remount.
function deviceHour12(): boolean | undefined {
  try {
    const uses24 = getCalendars()[0]?.uses24hourClock;
    return uses24 == null ? undefined : !uses24;
  } catch {
    // expo-localization unavailable (web / native module unlinked / dev
    // fallback) — defer to the locale default rather than crashing the render.
    return undefined;
  }
}

// Format an epoch-SECONDS instant as a local wall-clock time (e.g. "14:30" or
// "2:30 PM"), honoring the device's 12/24-hour preference. Absolute time, not a
// countdown, so a rendered value doesn't go stale between renders.
export function formatClockTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: deviceHour12(),
  });
}

const RESET_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// The 12-hour clock in its shortest unambiguous form ("9:24pm" rather than
// "09:24 PM"), for meters whose cell is sized for a 24-hour time. A 24-hour
// clock is returned unchanged; it is already as short as the cell expects.
function formatCompactClockTime(epochSeconds: number): string {
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: deviceHour12(),
  }).formatToParts(new Date(epochSeconds * 1000));
  if (!parts.some((part) => part.type === 'dayPeriod')) return formatClockTime(epochSeconds);
  return parts
    .filter(
      (part, index) =>
        !(
          part.type === 'literal' &&
          part.value.trim() === '' &&
          (parts[index + 1]?.type === 'dayPeriod' || parts[index - 1]?.type === 'dayPeriod')
        ),
    )
    .map((part) =>
      part.type === 'hour'
        ? part.value.replace(/^0(?=\d)/, '')
        : part.type === 'dayPeriod'
          ? part.value.toLowerCase()
          : part.value,
    )
    .join('');
}

/**
 * Format a quota reset consistently: weekly windows always include the weekday.
 * `compact` shortens a 12-hour clock for the narrow overview meters.
 */
export function formatResetDisplay(
  resetsAtSeconds: number,
  window: 'five_hour' | 'weekly',
  { compact = false }: { compact?: boolean } = {},
): string {
  const time = compact ? formatCompactClockTime(resetsAtSeconds) : formatClockTime(resetsAtSeconds);
  if (window === 'five_hour') return time;
  const day = RESET_WEEKDAYS[new Date(resetsAtSeconds * 1000).getDay()];
  return `${day} ${time}`;
}

// Whether two Date instants fall on the same local calendar day.
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Format an epoch-MILLISECONDS instant as a compact turn marker: just the
// wall-clock time when it happened today (e.g. "14:32"), or a numeric day/month
// prefix when it's older (e.g. "11.07. 14:32"). Kept terse and unobtrusive so it
// reads as a subtle orientation cue before a chat turn, not a full datestamp.
// `now` is injectable for testing; defaults to the current instant.
export function formatTurnTimestamp(epochMs: number, now: Date = new Date()): string {
  const when = new Date(epochMs);
  const time = when.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: deviceHour12(),
  });
  if (sameLocalDay(when, now)) return time;
  const day = String(when.getDate()).padStart(2, '0');
  const month = String(when.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}. ${time}`;
}
