import { deviceActivityLabel } from './deviceActivity';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const PAIRED = Date.parse('2026-09-16T07:18:00Z');

const ago = (ms: number): number => NOW - ms;

it('never reports finer than the five-minute stamp the server writes', () => {
  // A stamp is refreshed at most every five minutes, so "Active 2 minutes ago"
  // would be a number the server never measured — the device may well have been
  // active thirty seconds ago and the row would still read the same.
  expect(deviceActivityLabel({ lastSeenAt: ago(0), createdAt: PAIRED }, NOW)).toBe(
    'Active just now',
  );
  expect(deviceActivityLabel({ lastSeenAt: ago(4 * 60_000), createdAt: PAIRED }, NOW)).toBe(
    'Active just now',
  );
  expect(deviceActivityLabel({ lastSeenAt: ago(5 * 60_000), createdAt: PAIRED }, NOW)).toBe(
    'Active 5 minutes ago',
  );
});

it('widens the unit as the stamp ages, and falls back to a date past a month', () => {
  expect(deviceActivityLabel({ lastSeenAt: ago(59 * 60_000), createdAt: PAIRED }, NOW)).toBe(
    'Active 59 minutes ago',
  );
  expect(deviceActivityLabel({ lastSeenAt: ago(60 * 60_000), createdAt: PAIRED }, NOW)).toBe(
    'Active 1 hour ago',
  );
  expect(deviceActivityLabel({ lastSeenAt: ago(25 * 3_600_000), createdAt: PAIRED }, NOW)).toBe(
    'Active 1 day ago',
  );
  expect(deviceActivityLabel({ lastSeenAt: ago(30 * 86_400_000), createdAt: PAIRED }, NOW)).toBe(
    'Active 30 days ago',
  );
  const old = ago(200 * 86_400_000);
  expect(deviceActivityLabel({ lastSeenAt: old, createdAt: PAIRED }, NOW)).toBe(
    `Active ${new Date(old).toLocaleDateString()}`,
  );
});

it('reads a skewed future stamp as current rather than as a negative age', () => {
  // The stamp comes from the server's clock and the comparison runs on the
  // phone's. A few seconds of skew must not render "Active -1 minutes ago".
  expect(deviceActivityLabel({ lastSeenAt: NOW + 90_000, createdAt: PAIRED }, NOW)).toBe(
    'Active just now',
  );
});

it('falls back to the pairing date when the server has never stamped the device', () => {
  // Null means "not seen since the server learned to stamp" — which includes a
  // server too old to stamp at all. Claiming "never active" would be a lie.
  expect(deviceActivityLabel({ lastSeenAt: null, createdAt: PAIRED }, NOW)).toBe(
    `Paired ${new Date(PAIRED).toLocaleDateString()}`,
  );
});

it('says nothing at all when neither timestamp is known', () => {
  // createdAt 0 is the server's fallback for rows predating the column default.
  // A "Paired 1.1.1970" line reads as a bug, so the row carries no subtitle.
  expect(deviceActivityLabel({ lastSeenAt: null, createdAt: 0 }, NOW)).toBeUndefined();
});
