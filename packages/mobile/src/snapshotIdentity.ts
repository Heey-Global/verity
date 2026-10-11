/** Compare immutable API snapshots, including nested JSON fields and field removal. */
export function sameSnapshotValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameSnapshotValue(value, right[index]))
    );
  }
  // Snapshot payloads are plain JSON records; never equate opaque objects such as dates.
  if (
    Object.getPrototypeOf(left) !== Object.prototype ||
    Object.getPrototypeOf(right) !== Object.prototype
  )
    return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) && sameSnapshotValue(leftRecord[key], rightRecord[key]),
    )
  );
}

/** Preserve unchanged records and list identity after a fresh API snapshot. */
export function reuseSnapshotRecords<T>(previous: T[], next: T[], key: (record: T) => string): T[] {
  const byId = new Map(previous.map((record) => [key(record), record]));
  const shared = next.map((record) => {
    const old = byId.get(key(record));
    return old !== undefined && sameSnapshotValue(old, record) ? old : record;
  });
  return shared.length === previous.length &&
    shared.every((record, index) => record === previous[index])
    ? previous
    : shared;
}
