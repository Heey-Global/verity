import { describe, expect, it } from 'vitest';
import { createRevisions } from './revisions.js';

describe('createRevisions', () => {
  // Views drop a `session.summary` whose revision is not above the one they
  // hold; a forgotten session starting over below it would never change again.
  it('keeps a forgotten entity above everything it published before', () => {
    let now = 1_000;
    const revisions = createRevisions(() => now);
    const first = revisions.next('s1');
    const second = revisions.next('s1');
    expect(second).toBeGreaterThan(first);
    for (let i = 0; i < 4_097; i += 1) revisions.next(`other-${i}`);
    now += 1;
    expect(revisions.next('s1')).toBeGreaterThan(second);
  });
});
