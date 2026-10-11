import { expect, it } from 'vitest';
import { reuseSnapshotRecords, sameSnapshotValue } from './snapshotIdentity.js';

it('compares complete nested snapshots without depending on object key order', () => {
  expect(
    sameSnapshotValue(
      { a: { checks: ['ok', 'pending'] }, b: null },
      { b: null, a: { checks: ['ok', 'pending'] } },
    ),
  ).toBe(true);
  expect(sameSnapshotValue({ checks: ['ok', 'pending'] }, { checks: ['pending', 'ok'] })).toBe(
    false,
  );
  expect(sameSnapshotValue({ optional: undefined }, {})).toBe(false);
  expect(sameSnapshotValue({ a: { state: 'ok' } }, { a: { state: 'failed' } })).toBe(false);
  expect(sameSnapshotValue(new Date(0), new Date(1))).toBe(false);
});

it('retains only current unchanged records and reflects additions, removal and ordering', () => {
  const a = { id: 'a', nested: { value: 1 } };
  const b = { id: 'b', nested: { value: 2 } };
  const previous = [a, b];
  const key = (record: typeof a) => record.id;
  expect(reuseSnapshotRecords(previous, structuredClone(previous), key)).toBe(previous);
  expect(reuseSnapshotRecords(previous, [{ ...b }, { ...a }], key)).toEqual([b, a]);
  const changed = { id: 'a', nested: { value: 3 } };
  const next = reuseSnapshotRecords(
    previous,
    [changed, { ...b }, { id: 'c', nested: { value: 4 } }],
    key,
  );
  expect(next[0]).toBe(changed);
  expect(next[1]).toBe(b);
  expect(reuseSnapshotRecords(next, [{ ...b }], key)).toEqual([b]);
});
