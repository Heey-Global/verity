import { describe, expect, it } from 'vitest';
import { ManagedDevServerLiveness } from './managed-dev-server-liveness.js';

describe('managed server activity evidence', () => {
  it('requires fresh evidence for every desired instance and forgets stopped instances', () => {
    let now = 100;
    const live = new ManagedDevServerLiveness(() => now, 6_000);
    expect(live.unverified('p')).toBe(true);
    live.reconcile([{ id: 'one', projectId: 'p' }]);
    expect(live.running('p')).toBe(false);
    expect(live.unverified('p')).toBe(true);
    live.verify('one');
    expect(live.running('p')).toBe(true);
    expect(live.unverified('p')).toBe(false);
    now += 6_001;
    expect(live.running('p')).toBe(false);
    expect(live.unverified('p')).toBe(true);
    live.verify('one');
    live.invalidate('one');
    expect(live.running('p')).toBe(false);
    live.reconcile([]);
    expect(live.unverified('p')).toBe(false);
  });

  it('does not let one healthy instance conceal an unverified sibling', () => {
    const live = new ManagedDevServerLiveness(() => 0, 6_000);
    live.reconcile([
      { id: 'one', projectId: 'p' },
      { id: 'two', projectId: 'p' },
    ]);
    live.verify('one');
    expect(live.running('p')).toBe(true);
    expect(live.unverified('p')).toBe(true);
    live.remove('two');
    expect(live.unverified('p')).toBe(false);
  });
});
