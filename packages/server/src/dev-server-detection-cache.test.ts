import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import { DevServerDetectionCache } from './dev-server-detection-cache.js';

const project = { id: 'p1' } as ProjectRecord;
const suggestion = {
  key: '.:dev',
  name: 'Web',
  command: 'npm run dev',
  workdir: null,
  containerPort: '5173',
  confidence: 'medium' as const,
  evidence: 'Vite',
};

describe('DevServerDetectionCache', () => {
  it('deduplicates in-flight and fresh reads until expiry', async () => {
    let now = 1_000;
    let resolve!: (value: (typeof suggestion)[]) => void;
    const detect = vi.fn(() => new Promise<(typeof suggestion)[]>((done) => (resolve = done)));
    const cache = new DevServerDetectionCache(detect, 100, () => now);

    const first = cache.get(project);
    const concurrent = cache.get(project);
    expect(first).toBe(concurrent);
    expect(detect).toHaveBeenCalledTimes(1);
    resolve([suggestion]);
    await expect(first).resolves.toEqual([suggestion]);

    now = 1_099;
    await cache.get(project);
    expect(detect).toHaveBeenCalledTimes(1);
    now = 1_100;
    void cache.get(project);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('invalidates explicitly and evicts rejected scans', async () => {
    const detect = vi
      .fn<() => Promise<(typeof suggestion)[]>>()
      .mockResolvedValueOnce([suggestion])
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValueOnce([]);
    const cache = new DevServerDetectionCache(detect);

    await cache.get(project);
    cache.invalidate(project.id);
    await expect(cache.get(project)).rejects.toThrow('scan failed');
    await expect(cache.get(project)).resolves.toEqual([]);
    expect(detect).toHaveBeenCalledTimes(3);
  });

  it('keeps a slow in-flight scan deduplicated and starts its TTL after resolution', async () => {
    let now = 1_000;
    let resolve!: (value: (typeof suggestion)[]) => void;
    const detect = vi.fn(() => new Promise<(typeof suggestion)[]>((done) => (resolve = done)));
    const cache = new DevServerDetectionCache(detect, 100, () => now);

    const first = cache.get(project);
    now = 5_000;
    expect(cache.get(project)).toBe(first);
    expect(detect).toHaveBeenCalledTimes(1);

    resolve([suggestion]);
    await first;
    now = 5_099;
    await cache.get(project);
    expect(detect).toHaveBeenCalledTimes(1);
    now = 5_100;
    void cache.get(project);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('never returns an obsolete in-flight result after invalidation', async () => {
    let resolveOld!: (value: (typeof suggestion)[]) => void;
    let resolveFresh!: (value: (typeof suggestion)[]) => void;
    const oldResult = new Promise<(typeof suggestion)[]>((resolve) => (resolveOld = resolve));
    const freshResult = new Promise<(typeof suggestion)[]>((resolve) => (resolveFresh = resolve));
    const detect = vi.fn().mockReturnValueOnce(oldResult).mockReturnValueOnce(freshResult);
    const cache = new DevServerDetectionCache(detect);

    const beforeInvalidation = cache.get(project);
    cache.invalidate(project.id);
    const afterInvalidation = cache.get(project);
    resolveFresh([]);
    await expect(afterInvalidation).resolves.toEqual([]);
    resolveOld([suggestion]);
    await expect(beforeInvalidation).resolves.toEqual([]);
    expect(detect).toHaveBeenCalledTimes(2);
  });
});
