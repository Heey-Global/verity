import { describe, expect, it } from 'vitest';
import {
  runnerCacheReclamationSchema,
  storageReclamationActionSchema,
} from './storage-reclamation.js';

const action = {
  supported: true,
  state: 'completed',
  startedAt: null,
  completedAt: null,
  error: null,
  nativePending: false,
  nativeBuildkit: null,
  result: {
    imagesRemoved: 0,
    containersRemoved: 0,
    dependenciesRemoved: 0,
    worktreesRetired: 0,
    filesystemFreeBytesChange: null,
    retainedPins: [],
    blockers: [],
  },
};
const caches = {
  observedAt: '2026-11-03T21:20:00.000Z',
  sharedBytes: null,
  legacyBytes: null,
  removedBytes: 0,
  legacyCachesRemoved: 0,
  sharedCachesPruned: 0,
  usageComplete: false,
  blockers: ['Cache usage is unavailable'],
};

describe('runner cache reclamation reports', () => {
  it('accepts older action results and preserves unknown cache usage in new reports', () => {
    expect(storageReclamationActionSchema.parse(action).result).not.toHaveProperty('runnerCaches');
    const parsed = storageReclamationActionSchema.parse({
      ...action,
      result: { ...action.result, runnerCaches: caches },
    });
    expect(parsed.result?.runnerCaches).toEqual(caches);
  });

  it('rejects impossible allocation measurements and fractional removal counts', () => {
    for (const [key, value] of [
      ['sharedBytes', -1],
      ['legacyBytes', Infinity],
      ['removedBytes', -1],
      ['legacyCachesRemoved', 0.5],
      ['sharedCachesPruned', -1],
    ] as const) {
      expect(runnerCacheReclamationSchema.safeParse({ ...caches, [key]: value }).success).toBe(
        false,
      );
    }
  });
});
