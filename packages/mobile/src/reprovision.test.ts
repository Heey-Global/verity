import { describe, expect, it, vi } from 'vitest';

import type { ProjectRecord, ProjectState } from './api.js';
import { reprovisionActiveProjects } from './reprovision.js';

function project(id: string, state: ProjectState, owner = 'heey-global', repo = id): ProjectRecord {
  return {
    id,
    kind: 'github',
    owner,
    repo,
    containerName: `dev-${owner}--${repo}`,
    imageRef: null,
    state,
    provisionError: null,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
  };
}

describe('reprovisionActiveProjects', () => {
  it('recreates only active projects, skipping non-active states', async () => {
    const projects = [
      project('a', 'active'),
      project('b', 'absent'),
      project('c', 'cloning'),
      project('d', 'container_starting'),
      project('e', 'failed'),
      project('f', 'active'),
    ];
    const recreate = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);

    const result = await reprovisionActiveProjects(projects, recreate);

    expect(recreate).toHaveBeenCalledTimes(2);
    expect(recreate.mock.calls.map((call) => call[0])).toEqual(['a', 'f']);
    expect(result).toEqual({ total: 2, done: 2, failed: [] });
  });

  it('returns total 0 when no project is active', async () => {
    const recreate = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    const result = await reprovisionActiveProjects([project('a', 'absent')], recreate);
    expect(recreate).not.toHaveBeenCalled();
    expect(result).toEqual({ total: 0, done: 0, failed: [] });
  });

  it('collects failures as owner/repo and continues past them', async () => {
    const projects = [
      project('a', 'active', 'heey-global', 'verity'),
      project('b', 'active', 'example-org', 'sample-app'),
      project('c', 'active', 'heey-global', 'k8s'),
    ];
    const recreate = vi.fn<(id: string) => Promise<void>>(async (id) => {
      if (id === 'b') throw new Error('boom');
    });

    const result = await reprovisionActiveProjects(projects, recreate);

    expect(recreate).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ total: 3, done: 3, failed: ['example-org/sample-app'] });
  });

  it('reports incremental progress, ending at done === total', async () => {
    const projects = [project('a', 'active'), project('b', 'active')];
    const recreate = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    const progress: Array<{ total: number; done: number }> = [];

    await reprovisionActiveProjects(projects, recreate, (p) => progress.push(p));

    expect(progress).toEqual([
      { total: 2, done: 0 },
      { total: 2, done: 1 },
      { total: 2, done: 2 },
    ]);
  });
});
