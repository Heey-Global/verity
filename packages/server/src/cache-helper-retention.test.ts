import { describe, expect, it, vi } from 'vitest';
import type { ContainerInspect, DockerClient, DockerContainerSummary } from './docker.js';
import {
  hasCacheHelperIdentity,
  isCacheHelper,
  retainLatestCacheHelper,
} from './cache-helper-retention.js';

const now = Date.parse('2026-11-09T19:00:00Z');
const day = 24 * 60 * 60_000;
function fixture() {
  const summaries = new Map<string, DockerContainerSummary>();
  const inspections = new Map<string, ContainerInspect>();
  const add = (id: string, age = 1000, projectId = 'project', state = 'exited') => {
    const labels = {
      'verity.project-id': projectId,
      'verity.component': 'runner-cache-maintenance',
    };
    const summary: DockerContainerSummary = {
      id,
      imageId: 'sha256:image',
      state,
      names: [`verity-cache-maintenance-${id.padStart(8, '0')}-1234-1234-1234-123456789abc`],
      labels,
      created: (now - age) / 1000,
    };
    const inspect: ContainerInspect = {
      id,
      running: false,
      imageId: summary.imageId,
      status: state,
      labels: { ...labels },
      finishedAt: new Date(now - age).toISOString(),
      exitCode: 1,
    };
    summaries.set(id, summary);
    inspections.set(id, inspect);
    return { summary, inspect };
  };
  const listContainers = vi.fn(async () => structuredClone([...summaries.values()]));
  const inspectContainer = vi.fn(async (id: string) => {
    const value = inspections.get(id);
    if (!value) throw new Error('missing container');
    return structuredClone(value);
  });
  const removeStoppedContainer = vi.fn(async (id: string) => {
    if (inspections.get(id)?.running) throw new Error('container running');
    summaries.delete(id);
    inspections.delete(id);
  });
  const docker = {
    listContainers,
    inspectContainer,
    removeStoppedContainer,
  } as unknown as DockerClient;
  const run = (extra: Partial<Parameters<typeof retainLatestCacheHelper>[0]> = {}) =>
    retainLatestCacheHelper({ docker, projectId: 'project', now, ...extra });
  return {
    add,
    run,
    summaries,
    inspections,
    listContainers,
    inspectContainer,
    removeStoppedContainer,
    docker,
  };
}

describe('cache helper retention', () => {
  it('retains only the newest terminal run across repeated failures', async () => {
    const f = fixture();
    f.add('a', 3000);
    f.add('b', 2000);
    f.add('c', 1000);
    expect(await f.run()).toEqual({ blocked: false, removed: ['b', 'a'], retained: ['c'] });
    expect([...f.summaries.keys()]).toEqual(['c']);
    f.add('d', 0);
    expect(await f.run()).toEqual({ blocked: false, removed: ['c'], retained: ['d'] });
    expect(f.removeStoppedContainer.mock.calls).toEqual([['b'], ['a'], ['c']]);
  });
  it('uses a deterministic ID tie-break independent of inventory order', async () => {
    const f = fixture();
    f.add('b');
    f.add('a');
    expect(await f.run()).toEqual({ blocked: false, removed: ['b'], retained: ['a'] });
  });
  it('does not collect another project or an unrelated container', async () => {
    const f = fixture();
    f.add('a');
    f.add('b', 2000, 'other');
    f.summaries.set('foreign', { id: 'foreign', imageId: 'foreign', state: 'exited' });
    expect(await f.run()).toEqual({ blocked: false, removed: [], retained: ['a'] });
    expect(f.inspectContainer.mock.calls).toEqual([['a']]);
    expect([...f.summaries.keys()]).toEqual(['a', 'b', 'foreign']);
  });
  it('bounds created failed-start evidence using the creation timestamp', async () => {
    const f = fixture();
    f.add('a', 2000, 'project', 'created');
    const last = f.add('b', 1000, 'project', 'created');
    delete last.inspect.finishedAt;
    expect(await f.run()).toEqual({ blocked: false, removed: ['a'], retained: ['b'] });
  });
  it('retains zero-exit evidence because invalid results cannot be inferred from exit status', async () => {
    const f = fixture();
    f.add('a', 2000);
    f.add('b').inspect.exitCode = 0;
    expect(await f.run()).toEqual({ blocked: false, removed: ['a'], retained: ['b'] });
  });
  it('recognizes partial identity but requires both labels and the managed name for ownership', () => {
    const f = fixture();
    const { summary } = f.add('a');
    expect(isCacheHelper(summary, 'project')).toBe(true);
    expect(isCacheHelper(summary, 'other')).toBe(false);
    summary.labels!['verity.component'] = 'other';
    expect(hasCacheHelperIdentity(summary)).toBe(true);
    expect(isCacheHelper(summary, 'project')).toBe(false);
    summary.names = ['foreign'];
    expect(hasCacheHelperIdentity(summary)).toBe(false);
  });
  it.each([
    [
      'running',
      (s: DockerContainerSummary, i: ContainerInspect) => {
        s.state = 'running';
        i.status = 'running';
        i.running = true;
      },
    ],
    [
      'running flag despite terminal status',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.running = true;
      },
    ],
    [
      'paused',
      (s: DockerContainerSummary, i: ContainerInspect) => {
        s.state = 'paused';
        i.status = 'paused';
      },
    ],
    [
      'missing name',
      (s: DockerContainerSummary) => {
        s.names = [];
      },
    ],
    [
      'wrong component',
      (s: DockerContainerSummary) => {
        s.labels!['verity.component'] = 'other';
      },
    ],
    [
      'inspect identity',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.id = 'replacement';
      },
    ],
    [
      'inspect project',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.labels!['verity.project-id'] = 'other';
      },
    ],
    [
      'inspect component',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.labels!['verity.component'] = 'other';
      },
    ],
    [
      'image missing',
      (s: DockerContainerSummary) => {
        s.imageId = '';
      },
    ],
    [
      'image changed',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.imageId = 'replacement';
      },
    ],
    [
      'state mismatch',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.status = 'created';
      },
    ],
    [
      'invalid time',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.finishedAt = 'unknown';
      },
    ],
    [
      'missing time',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        delete i.finishedAt;
      },
    ],
    [
      'future time',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.finishedAt = new Date(now + 1000).toISOString();
      },
    ],
    [
      'zero time',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.finishedAt = new Date(0).toISOString();
      },
    ],
  ] as const)('blocks all deletion and further admission with %s', async (_name, change) => {
    const f = fixture();
    f.add('a', 2000);
    const target = f.add('b');
    change(target.summary, target.inspect);
    expect(await f.run()).toMatchObject({ blocked: true, removed: [] });
    expect(f.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it.each([
    [
      'restart',
      (s: DockerContainerSummary, i: ContainerInspect) => {
        s.state = 'running';
        i.status = 'running';
        i.running = true;
      },
    ],
    [
      'labels',
      (s: DockerContainerSummary) => {
        s.labels!['verity.project-id'] = 'other';
      },
    ],
    [
      'image',
      (s: DockerContainerSummary) => {
        s.imageId = 'replacement';
      },
    ],
    [
      'name',
      (s: DockerContainerSummary) => {
        s.names = ['unmanaged'];
      },
    ],
    [
      'created time',
      (s: DockerContainerSummary) => {
        s.created! += 1;
      },
    ],
    [
      'finish time',
      (_s: DockerContainerSummary, i: ContainerInspect) => {
        i.finishedAt = new Date(now).toISOString();
      },
    ],
  ] as const)('rechecks %s at mutation time', async (_name, change) => {
    const f = fixture();
    const old = f.add('a', 2000);
    f.add('b');
    f.listContainers.mockImplementationOnce(async () => structuredClone([...f.summaries.values()]));
    f.listContainers.mockImplementationOnce(async () => {
      change(old.summary, old.inspect);
      return structuredClone([...f.summaries.values()]);
    });
    expect(await f.run()).toMatchObject({ blocked: true, removed: [] });
    expect(f.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('surfaces non-forcing cleanup failure and leaves the evidence for retry', async () => {
    const f = fixture();
    f.add('a', 2000);
    f.add('b');
    f.removeStoppedContainer.mockRejectedValueOnce(new Error('container running'));
    await expect(f.run()).rejects.toThrow('container running');
    expect([...f.summaries.keys()]).toEqual(['a', 'b']);
    expect(await f.run()).toMatchObject({ blocked: false, removed: ['a'], retained: ['b'] });
  });
  it('reports dry-run candidates without removing them', async () => {
    const f = fixture();
    f.add('a', 2000);
    f.add('b');
    expect(await f.run({ dryRun: true })).toEqual({
      blocked: false,
      removed: ['a'],
      retained: ['b'],
    });
    expect(f.removeStoppedContainer).not.toHaveBeenCalled();
    expect([...f.summaries.keys()]).toEqual(['a', 'b']);
  });
  it('expires the retained run at seven days, but not one millisecond earlier', async () => {
    const f = fixture();
    f.add('a', 7 * day - 1);
    expect(await f.run({ expireAfterMs: 7 * day })).toEqual({
      blocked: false,
      removed: [],
      retained: ['a'],
    });
    expect(await f.run({ now: now + 1, expireAfterMs: 7 * day })).toEqual({
      blocked: false,
      removed: ['a'],
      retained: [],
    });
  });
  it('fails closed when the inventory exceeds its bounded scan', async () => {
    const f = fixture();
    f.listContainers.mockResolvedValueOnce(
      Array.from({ length: 1001 }, (_, n) => ({ id: String(n), imageId: 'image' })),
    );
    expect(await f.run()).toEqual({ blocked: true, removed: [], retained: [] });
    expect(f.inspectContainer).not.toHaveBeenCalled();
    expect(f.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('fails closed when required Docker capabilities are missing', async () => {
    const f = fixture();
    expect(
      await f.run({ docker: { inspectContainer: f.inspectContainer } as unknown as DockerClient }),
    ).toEqual({ blocked: true, removed: [], retained: [] });
  });
});
