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
