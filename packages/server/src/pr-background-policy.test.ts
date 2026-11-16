import type { ProjectRecord, SessionRecord } from '@verity/store';
import { expect, it, vi } from 'vitest';
import { createPrBackgroundPolicy } from './pr-background-policy.js';

it('invalidates after pause/resume between ticks and does not reset on unrelated edits', async () => {
  const session = { projectId: 'p', worktree: '/wt' } as SessionRecord;
  let project = {
    id: 'p',
    state: 'active',
    stateChangedAt: new Date(1),
    hiddenAt: null,
  } as ProjectRecord;
  const invalidate = vi.fn();
  const policy = createPrBackgroundPolicy({
    store: { getProject: async () => project },
    invalidate,
  });
  // Foreground reads may have filled the cache before the monitor's first tick.
  expect(await policy.allows(session)).toBe(true);
  expect(invalidate).toHaveBeenCalledOnce();
  invalidate.mockClear();
  project = { ...project, updatedAt: new Date(20) };
  expect(await policy.allows(session)).toBe(true);
  expect(invalidate).not.toHaveBeenCalled();
  project = { ...project, stateChangedAt: new Date(30) };
  expect(await policy.allows(session)).toBe(true);
  expect(invalidate).toHaveBeenCalledOnce();
  project = { ...project, state: 'absent', stateChangedAt: new Date(40) };
  expect(await policy.allows(session)).toBe(false);
  expect(await policy.allows(session)).toBe(false);
  expect(invalidate).toHaveBeenCalledTimes(2);
  policy.prune(new Set());
  await policy.allows(session);
  expect(invalidate).toHaveBeenCalledTimes(3);
});
