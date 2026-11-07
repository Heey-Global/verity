import { describe, expect, it } from 'vitest';
import { storedMockupScreens, storedMockupState } from './store.js';

describe('storedMockupScreens', () => {
  const screen = { name: 'Home', attachment: 'a', mediaType: 'image/png', width: 1, height: 1 };

  it('reads a comment left by an earlier version as discarded, without its text', () => {
    // An earlier round with comments must never count as approved after an upgrade.
    expect(
      storedMockupScreens([{ ...screen, verdict: 'comment', comment: 'Larger title' }]),
    ).toEqual([{ ...screen, verdict: 'discarded' }]);
  });

  it('keeps current marks and treats an unknown one as not approved', () => {
    expect(
      storedMockupScreens([
        { ...screen, verdict: 'approved' },
        { ...screen, verdict: 'open' },
        { ...screen, verdict: 'discarded' },
        { ...screen, verdict: 'whatever' },
      ]).map((entry) => entry.verdict),
    ).toEqual(['approved', 'open', 'discarded', 'discarded']);
  });

  it('reads anything but an array as no screens and drops malformed entries', () => {
    expect(storedMockupScreens(null)).toEqual([]);
    expect(storedMockupScreens({})).toEqual([]);
    // One corrupt entry must not fail every load of the session.
    expect(
      storedMockupScreens([
        null,
        'x',
        { name: 'Half', verdict: 'open' },
        { ...screen, verdict: 'open' },
      ]),
    ).toEqual([{ ...screen, verdict: 'open' }]);
  });
});

describe('storedMockupState', () => {
  it('reopens a round an earlier version left revising', () => {
    // Nothing moves a revising round on any more; read as is it would stay stuck.
    expect(storedMockupState('revising')).toBe('pending');
    expect(storedMockupState('approved')).toBe('approved');
    expect(storedMockupState(null)).toBeNull();
  });
});
