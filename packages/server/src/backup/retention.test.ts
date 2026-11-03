import { describe, expect, it } from 'vitest';
import { retainedSnapshots, type RetentionSnapshot } from './retention.js';

describe('backup retention', () => {
  it('retains all recent snapshots, calendar buckets and two pre-update snapshots across repositories', () => {
    const now = Date.UTC(2026, 9, 25, 12);
    const snapshots: RetentionSnapshot[] = Array.from({ length: 240 }, (_, index) => ({
      repositoryNumber: index < 120 ? 1 : 2,
      sequence: index + 1,
      capturedAt: new Date(now - (239 - index) * 24 * 3600_000).toISOString(),
      preUpdate: index === 0 || index === 1 || index === 2,
    }));
    const retained = retainedSnapshots(snapshots, now);
    expect(retained.has('2/240')).toBe(true);
    expect(retained.has('2/239')).toBe(true);
    expect(retained.has('2/238')).toBe(true);
    expect(retained.has('1/2')).toBe(true);
    expect(retained.has('1/3')).toBe(true);
    expect(retained.has('1/1')).toBe(false);
    expect(retained.size).toBeLessThan(30);
  });
  it('matches an independently enumerated UTC calendar set including boundaries and clock rollback', () => {
    const now = Date.parse('2026-10-26T00:00:00Z');
    // Ordered oldest to newest. Duplicate bucket entries must not consume another slot.
    const dates = [
      '2026-02-01T00:00:00Z',
      '2026-03-01T00:00:00Z',
      '2026-04-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
      '2026-06-01T00:00:00Z',
      '2026-07-01T00:00:00Z',
      '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
      '2026-09-27T23:59:59Z',
      '2026-09-28T00:00:00Z',
      '2026-10-04T23:59:59Z',
      '2026-10-05T00:00:00Z',
      '2026-10-11T23:59:59Z',
      '2026-10-12T00:00:00Z',
      '2026-10-17T23:59:59Z',
      '2026-10-18T00:00:00Z',
      '2026-10-19T00:00:00Z',
      '2026-10-20T00:00:00Z',
      '2026-10-21T00:00:00Z',
      '2026-10-22T00:00:00Z',
      '2026-10-23T00:00:00Z',
      '2026-10-23T23:59:59Z',
      '2026-10-24T00:00:00Z',
      '2026-10-24T00:00:01Z',
      '2026-10-25T23:59:59Z',
      '2026-10-25T23:59:59.999Z',
    ];
    const snapshots = dates.map((capturedAt, index) => ({
      repositoryNumber: index < 8 ? 1 : 2,
      sequence: index + 1,
      capturedAt,
      preUpdate: index < 3,
    }));
    // Recent: 23..25; daily: 22,20,19,18,17,16,15;
    // weekly: 22,16,13,11; monthly: 22,10,7,6,5,4;
    // pre-update: 2,3; recent: 26.
    const expected = new Set([
      '1/2',
      '1/3',
      '1/4',
      '1/5',
      '1/6',
      '1/7',
      '2/10',
      '2/11',
      '2/13',
      '2/15',
      '2/16',
      '2/17',
      '2/18',
      '2/19',
      '2/20',
      '2/22',
      '2/23',
      '2/24',
      '2/25',
      '2/26',
    ]);
    expect(retainedSnapshots(snapshots, now)).toEqual(expected);
    expect(retainedSnapshots([...snapshots].reverse(), now)).toEqual(expected);
    // The contract orders by repository/sequence, never wall time. A clock rollback
    // consumes one slot in each calendar tier while still preserving the newest.
    snapshots[25]!.capturedAt = '2020-01-01T00:00:00Z';
    const rolledBack = new Set(expected);
    for (const displaced of ['2/15', '2/11', '1/4']) rolledBack.delete(displaced);
    expect(retainedSnapshots(snapshots, now)).toEqual(rolledBack);
  });
  it('uses repository and sequence for newest even when timestamps move backwards', () => {
    const snapshots = [
      { repositoryNumber: 1, sequence: 100, capturedAt: '2026-10-25T00:00:00Z', preUpdate: false },
      { repositoryNumber: 2, sequence: 1, capturedAt: '2020-01-01T00:00:00Z', preUpdate: false },
    ];
    const kept = retainedSnapshots(snapshots, Date.UTC(2026, 9, 25));
    expect(kept.has('2/1')).toBe(true);
    expect(() =>
      retainedSnapshots([{ ...snapshots[0]!, capturedAt: 'invalid' }], Date.now()),
    ).toThrow();
  });
});
