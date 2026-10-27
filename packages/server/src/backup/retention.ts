export interface RetentionSnapshot {
  repositoryNumber: number;
  sequence: number;
  capturedAt: string;
  preUpdate: boolean;
}
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
function key(snapshot: RetentionSnapshot): string {
  return `${snapshot.repositoryNumber}/${snapshot.sequence}`;
}
function bucket(timestamp: number, kind: 'day' | 'week' | 'month'): string {
  const date = new Date(timestamp);
  if (kind === 'month') return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
  const day = Math.floor(timestamp / DAY);
  // 1970-01-01 was Thursday; Monday is the calendar-week boundary.
  return kind === 'day' ? String(day) : String(Math.floor((day + 3) / 7));
}
/** Sequence orders snapshots; signed timestamps only choose UTC calendar buckets. */
export function retainedSnapshots(
  snapshots: readonly RetentionSnapshot[],
  now: number,
): Set<string> {
  if (!Number.isFinite(now)) throw new Error('Invalid retention time');
  const ordered = [...snapshots].sort(
    (a, b) => b.repositoryNumber - a.repositoryNumber || b.sequence - a.sequence,
  );
  const kept = new Set<string>();
  for (const snapshot of ordered) {
    if (
      !Number.isSafeInteger(snapshot.repositoryNumber) ||
      snapshot.repositoryNumber < 1 ||
      !Number.isSafeInteger(snapshot.sequence) ||
      snapshot.sequence < 1 ||
      !Number.isFinite(Date.parse(snapshot.capturedAt))
    )
      throw new Error('Invalid retention catalog');
    if (Date.parse(snapshot.capturedAt) >= now - 48 * HOUR) kept.add(key(snapshot));
  }
  // Preserve at least the newest complete snapshot even if the host clock moved.
  if (ordered[0]) kept.add(key(ordered[0]));
  for (const [kind, maximum] of [
    ['day', 7],
    ['week', 4],
    ['month', 6],
  ] as const) {
    const buckets = new Set<string>();
    for (const snapshot of ordered) {
      const timestamp = Date.parse(snapshot.capturedAt);
      if (timestamp >= now - 48 * HOUR) continue;
      const id = bucket(timestamp, kind);
      if (buckets.has(id) || buckets.size >= maximum) continue;
      buckets.add(id);
      kept.add(key(snapshot));
    }
  }
  for (const snapshot of ordered.filter((s) => s.preUpdate).slice(0, 2)) kept.add(key(snapshot));
  return kept;
}
export const GC_GRACE_MS = DAY;
