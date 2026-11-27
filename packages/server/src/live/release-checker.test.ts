import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { ReleaseSummary } from '../forge-provider.js';
import type { ServerContext } from '../server-context.js';
import { DomainEventBus } from './domain-events.js';
import { installReleaseChecker } from './release-checker.js';

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    kind: 'github',
    owner: 'team',
    repo: id,
    latestReleaseTag: null,
    latestReleaseName: null,
    latestReleaseUrl: null,
    latestReleasePublishedAt: null,
    ...overrides,
  } as ProjectRecord;
}

const release: ReleaseSummary = {
  tag: 'v1.2.0',
  name: 'One two',
  url: 'https://github.com/team/p1/releases/tag/v1.2.0',
  publishedAt: '2026-11-26T09:00:00Z',
};

function setup(rows: ProjectRecord[], options: { defer?: boolean } = {}) {
  const projects = new Map(rows.map((row) => [row.id, row]));
  const refreshLatestRelease = vi
    .fn<(owner: string, repo: string) => Promise<ReleaseSummary | null | undefined>>()
    .mockResolvedValue(release);
  const updateProjectReleaseStatus = vi.fn(async () => undefined);
  const every = vi.fn();
  const domainEvents = new DomainEventBus();
  const ctx = {
    deps: {
      eventStore: {
        getProject: async (id: string) => projects.get(id),
        updateProjectReleaseStatus,
      },
      refreshLatestRelease,
      deferBackgroundForgeReads: async () => options.defer === true,
    },
    domainEvents,
    lifecycle: { every, onClose: () => undefined },
  } as unknown as ServerContext;
  const checker = installReleaseChecker({ log: { warn: () => undefined } }, ctx);
  const watch = (id: string) => domainEvents.subscribe(`project:${id}`, undefined, () => {});
  return { checker, refreshLatestRelease, updateProjectReleaseStatus, every, watch };
}

describe('installReleaseChecker', () => {
  // Looking at every project would spend forge quota on repositories nobody
  // has open; not looking at a watched one leaves its badge stale.
  it('looks only at watched projects and stores a release that changed', async () => {
    const r = setup([project('p1'), project('p2')]);
    r.watch('p1');
    await r.checker.check();
    expect(r.refreshLatestRelease.mock.calls).toEqual([['team', 'p1']]);
    expect(r.updateProjectReleaseStatus).toHaveBeenCalledWith('p1', {
      tag: 'v1.2.0',
      name: 'One two',
      url: 'https://github.com/team/p1/releases/tag/v1.2.0',
      publishedAt: '2026-11-26T09:00:00Z',
    });
    expect(r.every).toHaveBeenCalledWith(60_000, expect.any(Function), { startWhenReady: true });
  });

  it('stops looking once the last viewer unsubscribes', async () => {
    const r = setup([project('p1')]);
    r.watch('p1').unsubscribe();
    await r.checker.check();
    expect(r.refreshLatestRelease).not.toHaveBeenCalled();
  });

  it('writes nothing when the release is unchanged or unknown', async () => {
    const r = setup([
      project('p1', {
        latestReleaseTag: release.tag,
        latestReleaseName: release.name,
        latestReleaseUrl: release.url,
        latestReleasePublishedAt: release.publishedAt,
      }),
      project('p2'),
    ]);
    r.watch('p1');
    r.watch('p2');
    r.refreshLatestRelease.mockResolvedValueOnce(release).mockResolvedValueOnce(undefined);
    await r.checker.check();
    expect(r.refreshLatestRelease).toHaveBeenCalledTimes(2);
    expect(r.updateProjectReleaseStatus).not.toHaveBeenCalled();
  });

  it('skips projects without forge releases and defers near the quota', async () => {
    const r = setup([
      project('local', { kind: 'local' }),
      project('forgejo', { kind: 'forgejo' }),
      project('plane', { kind: 'control_plane' }),
    ]);
    for (const id of ['local', 'forgejo', 'plane']) r.watch(id);
    await r.checker.check();
    expect(r.refreshLatestRelease).not.toHaveBeenCalled();

    const deferred = setup([project('p1')], { defer: true });
    deferred.watch('p1');
    await deferred.checker.check();
    expect(deferred.refreshLatestRelease).not.toHaveBeenCalled();
  });

  it('keeps checking the other projects when one fails', async () => {
    const r = setup([project('p1'), project('p2')]);
    r.watch('p1');
    r.watch('p2');
    r.refreshLatestRelease.mockRejectedValueOnce(new Error('offline'));
    await r.checker.check();
    expect(r.updateProjectReleaseStatus).toHaveBeenCalledTimes(1);
  });
});
