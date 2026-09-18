// How a paired device's activity reads in the Devices list.
//
// The server stamps `last_seen_at` at most once every five minutes per device
// (see TOUCH_INTERVAL_MS in packages/server/src/auth.ts), so this deliberately
// never claims a precision the stamp does not have: anything inside that window
// is "just now", and the buckets widen from there.

/** The stamp's own granularity. Below it, a minute count would be invented. */
const STAMP_RESOLUTION_MINUTES = 5;
const MINUTE = 60_000;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * Describe when a device was last authenticated against this server.
 *
 * `lastSeenAt` is null for a device the server has never stamped — either it has
 * not made a request since pairing, or the server predates the stamp — so the
 * pairing date is the honest fallback rather than a fabricated "never active".
 * A stamp in the future (clock skew between server and phone) reads as current
 * rather than as a negative age.
 */
export function deviceActivityLabel(
  device: { lastSeenAt: number | null; createdAt: number },
  now: number = Date.now(),
): string | undefined {
  if (device.lastSeenAt !== null) {
    const minutes = Math.floor((now - device.lastSeenAt) / MINUTE);
    if (minutes < STAMP_RESOLUTION_MINUTES) return 'Active just now';
    if (minutes < 60) return `Active ${plural(minutes, 'minute')}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Active ${plural(hours, 'hour')}`;
    const days = Math.floor(hours / 24);
    if (days <= 30) return `Active ${plural(days, 'day')}`;
    return `Active ${new Date(device.lastSeenAt).toLocaleDateString()}`;
  }
  // `createdAt` is 0 for rows predating the column's default, and a 1970 date
  // reads as a bug rather than as "unknown" — drop the line instead.
  if (device.createdAt > 0) return `Paired ${new Date(device.createdAt).toLocaleDateString()}`;
  return undefined;
}
