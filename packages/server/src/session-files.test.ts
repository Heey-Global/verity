import { describe, expect, it } from 'vitest';
import { hiddenSessionFileNames } from './session-files.js';
import { WORKTREE_SIDECAR } from './worktree.js';

describe('worktree recovery metadata visibility', () => {
  it('hides recovery metadata only at the checkout root', () => {
    // Recovery files must not look like session output in an otherwise empty project.
    for (const name of [WORKTREE_SIDECAR, `${WORKTREE_SIDECAR}.tmp`]) {
      expect(hiddenSessionFileNames('worktree', '')).toContain(name);
      expect(hiddenSessionFileNames('worktree', 'examples')).not.toContain(name);
      expect(hiddenSessionFileNames('knowledge', '')).not.toContain(name);
    }
  });
});
