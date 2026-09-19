import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';

import { createProjectListCache } from './project-list-cache.js';

const project = (collapsed: boolean): ProjectRecord =>
  ({ id: 'p1', owner: 'heey-global', repo: 'verity', collapsed }) as ProjectRecord;

describe('project list cache', () => {
  it('serves the memoised list inside the window and reloads after it', async () => {
    let clock = 0;
    const load = vi.fn(async () => [project(false)]);
    const cache = createProjectListCache(load, { ttlMs: 3_000, now: () => clock });

    await cache.list();
    clock = 2_999;
    await cache.list();
    expect(load).toHaveBeenCalledTimes(1);

    clock = 3_000;
    await cache.list();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping reads into one load', async () => {
    let release: (() => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<ProjectRecord[]>((resolve) => {
          release = () => resolve([project(false)]);
        }),
    );
    const cache = createProjectListCache(load, { ttlMs: 3_000 });

    const first = cache.list();
    const second = cache.list();
    expect(load).toHaveBeenCalledTimes(1);
    release!();
    expect(await first).toBe(await second);
  });

  it('reads the written row after an invalidation instead of the cached one', async () => {
    let stored = project(false);
    const load = vi.fn(async () => [stored]);
    const cache = createProjectListCache(load, { ttlMs: 3_000 });

    expect((await cache.list())[0]?.collapsed).toBe(false);
    stored = project(true);
    // Without the invalidation the write stays invisible for the whole window —
    // exactly what folded overview groups back open on the device.
    expect((await cache.list())[0]?.collapsed).toBe(false);
    cache.invalidate();
    expect((await cache.list())[0]?.collapsed).toBe(true);
  });

  it('does not let a load that started before the write repopulate the cache', async () => {
    let stored = project(false);
    let release: (() => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<ProjectRecord[]>((resolve) => {
          const snapshot = stored;
          release = () => resolve([snapshot]);
        }),
    );
    const cache = createProjectListCache(load, { ttlMs: 3_000 });

    const before = cache.list();
    const finishBefore = release!;
    stored = project(true);
    cache.invalidate();
    // A read after the write must not join the pre-write load, and must not
    // run the loader's side effects alongside it either: it waits its turn.
    const after = cache.list();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);

    finishBefore();
    expect((await before)[0]?.collapsed).toBe(false);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    release!();
    expect((await after)[0]?.collapsed).toBe(true);
    // The pre-write result must not have been kept as the cached list.
    expect((await cache.list())[0]?.collapsed).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
