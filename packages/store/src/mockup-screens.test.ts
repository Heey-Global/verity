import { describe, expect, it } from 'vitest';
import { storedMockupScreens } from './store.js';

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

  it('reads anything but an array as no screens', () => {
    expect(storedMockupScreens(null)).toEqual([]);
    expect(storedMockupScreens({})).toEqual([]);
  });
});
