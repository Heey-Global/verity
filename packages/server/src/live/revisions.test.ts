import { describe, expect, it } from 'vitest';
import { createRevisions } from './revisions.js';

describe('createRevisions', () => {
  // Views drop a `session.summary` whose revision is not above the one they
  // hold. A burst within one clock millisecond runs ahead of the clock; no
  // entity may then be given a revision at or below one already issued.
  it('issues every revision above all earlier ones, also within one millisecond', () => {
    let now = 1_000;
    const revisions = createRevisions(() => now);
    const issued = ['s1', 's1', 's2', 's3', 's1'].map((id) => revisions.next(id));
    expect(issued).toEqual([...issued].sort((a, b) => a - b));
    expect(new Set(issued).size).toBe(issued.length);
    now += 1;
    expect(revisions.next('s4')).toBeGreaterThan(Math.max(...issued));
  });
});
