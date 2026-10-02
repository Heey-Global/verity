import { hasLocalSaveChanges } from './localSaveVisibility';

describe('local Save to project visibility', () => {
  it('hides clean sessions and sessions without a local project', () => {
    expect(hasLocalSaveChanges(undefined)).toBe(false);
    expect(hasLocalSaveChanges({ base: 'main', hasChanges: false })).toBe(false);
  });

  it('shows pending files and preserves the save action on older servers', () => {
    expect(hasLocalSaveChanges({ base: 'main', hasChanges: true })).toBe(true);
    // An omitted signal must not remove the only save action during rolling updates.
    expect(hasLocalSaveChanges({ base: 'main' })).toBe(true);
  });
});
