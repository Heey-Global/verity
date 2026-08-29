import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DOCKER_GC_POLICY,
  planImageSweep,
  planVolumeSweep,
  planBuilderVolumeSweep,
  planRelaySweep,
  runDockerGc,
  startDockerGcScheduler,
  type DockerGcDeps,
} from './docker-gc.js';
import { devcontainerImageTag, DEVCONTAINER_IMAGE_PREFIX } from './provisioner.js';
import { DockerError } from './docker.js';
import type {
  DockerClient,
  DockerContainerSummary,
  DockerImageSummary,
  DockerVolumeSummary,
} from './docker.js';

const ANON_LABEL = 'com.docker.volume.anonymous';
/** A daemon-generated anonymous volume name: 64 lowercase hex chars. */
const anonName = (seed: string): string => seed.repeat(64).slice(0, 64);

function image(partial: Partial<DockerImageSummary> & { id: string }): DockerImageSummary {
  return { repoTags: [], created: 0, size: 0, ...partial };
}

function volume(partial: Partial<DockerVolumeSummary> & { name: string }): DockerVolumeSummary {
  return { labels: { [ANON_LABEL]: '' }, ...partial };
}

const RELAY_COMPONENT = 'project-relay';
/** Value the component label carried before ADR 0013; still collectable. */
const LEGACY_RELAY_COMPONENT = 'project-broker-relay';
/** The clock every relay-sweep case is written against. */
const NOW_MS = Date.parse('2026-07-21T12:00:00Z');
/** Unix SECONDS — the Engine's unit for a container summary's creation time. */
const secondsAgo = (ms: number): number => (NOW_MS - ms) / 1000;

function relay(
  id: string,
  labels: Record<string, string>,
  created = secondsAgo(6 * 60 * 60_000),
): DockerContainerSummary {
  return {
    id,
    imageId: 'sha256:relay',
    names: [id],
    labels: { 'verity.component': RELAY_COMPONENT, ...labels },
    created,
  };
}

function sandbox(
  id: string,
  projectId: string,
  generation: string,
  created = secondsAgo(6 * 60 * 60_000),
): DockerContainerSummary {
  return {
    id,
    imageId: 'sha256:sandbox',
    names: [id],
    labels: { 'verity.project-id': projectId, 'verity.container-generation': generation },
    created,
  };
}

const identity = (projectId: string, generation: string): Record<string, string> => ({
  'verity.project-id': projectId,
  'verity.container-generation': generation,
});

const silentLog = { info: () => undefined, warn: () => undefined };

describe('planImageSweep', () => {
  it('keeps the newest N generations per repository and retires the rest', () => {
    const images = [
      image({ id: 'sha256:new', repoTags: ['verity-devc-acme-web:aaa'], created: 300, size: 10 }),
      image({ id: 'sha256:mid', repoTags: ['verity-devc-acme-web:bbb'], created: 200, size: 20 }),
      image({ id: 'sha256:old', repoTags: ['verity-devc-acme-web:ccc'], created: 100, size: 30 }),
    ];
    const plan = planImageSweep({ images, inUseImageIds: new Set(), keepPerRepo: 2 });
    expect(plan).toEqual([{ ref: 'verity-devc-acme-web:ccc', imageId: 'sha256:old', size: 30 }]);
  });

  it('groups per repository, so one busy repo does not evict another', () => {
    const images = [
      image({ id: 'sha256:w1', repoTags: ['verity-devc-acme-web:a'], created: 300 }),
      image({ id: 'sha256:w2', repoTags: ['verity-devc-acme-web:b'], created: 200 }),
      image({ id: 'sha256:a1', repoTags: ['verity-devc-acme-api:a'], created: 100 }),
    ];
    const plan = planImageSweep({ images, inUseImageIds: new Set(), keepPerRepo: 1 });
    expect(plan.map((entry) => entry.ref)).toEqual(['verity-devc-acme-web:b']);
  });

  it('never retires an image a container still references, however old', () => {
    const images = [
      image({ id: 'sha256:new', repoTags: ['verity-devc-acme-web:a'], created: 300 }),
      image({ id: 'sha256:mid', repoTags: ['verity-devc-acme-web:b'], created: 200 }),
      image({ id: 'sha256:pinned', repoTags: ['verity-devc-acme-web:c'], created: 100 }),
    ];
    const plan = planImageSweep({
      images,
      inUseImageIds: new Set(['sha256:pinned']),
      keepPerRepo: 1,
    });
    expect(plan.map((entry) => entry.ref)).toEqual(['verity-devc-acme-web:b']);
  });

  it('ignores every image outside the devcontainer prefix', () => {
    const images = [
      image({ id: 'sha256:pg1', repoTags: ['postgres:18-alpine'], created: 300 }),
      image({ id: 'sha256:pg2', repoTags: ['postgres:17-alpine'], created: 200 }),
      image({
        id: 'sha256:sb',
        repoTags: ['ghcr.io/heey-global/verity-sandbox:latest'],
        created: 1,
      }),
      image({ id: 'sha256:srv', repoTags: ['verity-server:local'], created: 1 }),
      image({ id: 'sha256:untagged', repoTags: [], created: 1 }),
    ];
    expect(planImageSweep({ images, inUseImageIds: new Set(), keepPerRepo: 0 })).toEqual([]);
  });

  it('matches the tags the provisioner actually mints', () => {
    const tag = devcontainerImageTag('Heey-Global', 'cl-saikandi-website', 'abcdef123456');
    const images = [
      image({ id: 'sha256:keep', repoTags: [tag], created: 200 }),
      image({
        id: 'sha256:drop',
        repoTags: [devcontainerImageTag('Heey-Global', 'cl-saikandi-website', '0123456789ab')],
        created: 100,
      }),
    ];
    const plan = planImageSweep({ images, inUseImageIds: new Set(), keepPerRepo: 1 });
    expect(tag.startsWith(DEVCONTAINER_IMAGE_PREFIX)).toBe(true);
    expect(plan.map((entry) => entry.ref)).toEqual([
      devcontainerImageTag('Heey-Global', 'cl-saikandi-website', '0123456789ab'),
    ]);
  });

  it('breaks created-time ties deterministically so repeated passes agree', () => {
    const images = [
      image({ id: 'sha256:bbb', repoTags: ['verity-devc-acme-web:b'], created: 100 }),
      image({ id: 'sha256:aaa', repoTags: ['verity-devc-acme-web:a'], created: 100 }),
    ];
    const first = planImageSweep({ images, inUseImageIds: new Set(), keepPerRepo: 1 });
    const second = planImageSweep({
      images: [...images].reverse(),
      inUseImageIds: new Set(),
      keepPerRepo: 1,
    });
    expect(first).toEqual(second);
  });
});

describe('planVolumeSweep', () => {
  const nowMs = Date.parse('2026-07-21T12:00:00Z');

  it('sweeps anonymous volumes past the grace period', () => {
    const volumes = [volume({ name: anonName('a'), createdAt: '2026-07-01T00:00:00Z' })];
    expect(planVolumeSweep({ volumes, nowMs, minAgeMs: 60_000 })).toEqual([anonName('a')]);
  });

  it('spares a volume younger than the grace period (create/start window)', () => {
    const volumes = [volume({ name: anonName('b'), createdAt: '2026-07-21T11:59:30Z' })];
    expect(planVolumeSweep({ volumes, nowMs, minAgeMs: 60 * 60_000 })).toEqual([]);
  });

  it('refuses any volume without the daemon anonymous label', () => {
    const volumes = [
      { name: anonName('c'), labels: {}, createdAt: '2026-07-01T00:00:00Z' },
      {
        name: anonName('d'),
        labels: { 'com.example.mine': '1' },
        createdAt: '2026-07-01T00:00:00Z',
      },
    ];
    expect(planVolumeSweep({ volumes, nowMs, minAgeMs: 0 })).toEqual([]);
  });

  it('refuses a named volume even if something mislabelled it as anonymous', () => {
    const volumes = [
      volume({ name: 'verity-data', createdAt: '2026-01-01T00:00:00Z' }),
      volume({ name: 'verity_verity-db', createdAt: '2026-01-01T00:00:00Z' }),
      volume({ name: 'cl-saikandi-node-modules', createdAt: '2026-01-01T00:00:00Z' }),
      volume({ name: anonName('e').toUpperCase(), createdAt: '2026-01-01T00:00:00Z' }),
    ];
    expect(planVolumeSweep({ volumes, nowMs, minAgeMs: 0 })).toEqual([]);
  });

  it('treats an absent or unparseable createdAt as old', () => {
    const volumes = [
      volume({ name: anonName('f') }),
      volume({ name: anonName('0'), createdAt: 'nonsense' }),
    ];
    expect(planVolumeSweep({ volumes, nowMs, minAgeMs: 60 * 60_000 })).toEqual([
      anonName('f'),
      anonName('0'),
    ]);
  });
});

describe('planBuilderVolumeSweep', () => {
  const nowMs = Date.parse('2026-07-21T12:00:00Z');
  const builder = (uuid: string): string => `buildx_buildkit_builder-${uuid}_state`;

  it('sweeps orphaned builder state volumes past the grace period', () => {
    const volumes = [volume({ name: builder('4fd1fb8a-06b2'), createdAt: '2026-07-01T00:00:00Z' })];
    expect(planBuilderVolumeSweep({ volumes, nowMs, minAgeMs: 60_000 })).toEqual([
      builder('4fd1fb8a-06b2'),
    ]);
  });

  it('spares a builder volume younger than the grace period', () => {
    const volumes = [volume({ name: builder('4fd1fb8a-06b2'), createdAt: '2026-07-21T11:59:30Z' })];
    expect(planBuilderVolumeSweep({ volumes, nowMs, minAgeMs: 60 * 60_000 })).toEqual([]);
  });

  it('ignores anonymous and named volumes — only builder state volumes match', () => {
    const volumes = [
      volume({ name: anonName('a'), createdAt: '2026-01-01T00:00:00Z' }),
      volume({ name: 'verity-data', createdAt: '2026-01-01T00:00:00Z' }),
      volume({ name: 'buildx_buildkit_builder-xyz', createdAt: '2026-01-01T00:00:00Z' }), // no _state suffix
    ];
    expect(planBuilderVolumeSweep({ volumes, nowMs, minAgeMs: 0 })).toEqual([]);
  });

  it('does not overlap with planVolumeSweep on the same listing', () => {
    // Name shapes are disjoint: a volume is claimed by at most one planner.
    const volumes = [
      volume({ name: anonName('a'), createdAt: '2026-01-01T00:00:00Z' }),
      volume({ name: builder('4fd1fb8a-06b2'), createdAt: '2026-01-01T00:00:00Z' }),
    ];
    const anon = planVolumeSweep({ volumes, nowMs, minAgeMs: 0 });
    const build = planBuilderVolumeSweep({ volumes, nowMs, minAgeMs: 0 });
    expect(anon).toEqual([anonName('a')]);
    expect(build).toEqual([builder('4fd1fb8a-06b2')]);
    expect(anon.filter((n) => build.includes(n))).toEqual([]);
  });
});

describe('planRelaySweep', () => {
  const minAgeMs = 30 * 60_000;

  it('collects the relay of a generation whose sandbox is gone, keeping the live one', () => {
    // The exact shape a control-plane restart leaves behind: generation `old`
    // survived `stop`, the recreate minted `new` beside it.
    const containers = [
      sandbox('sandbox-p1', 'p1', 'new'),
      relay('relay-new', identity('p1', 'new')),
      relay('relay-old', identity('p1', 'old')),
    ];
    expect(planRelaySweep({ containers, nowMs: NOW_MS, minAgeMs })).toEqual([
      { id: 'relay-old', name: 'relay-old', projectId: 'p1', generation: 'old' },
    ]);
  });

  it('collects a superseded relay still carrying the pre-ADR-0013 component label', () => {
    // Upgrade shape: the old relay predates the rename, the recreate minted the
    // new one. The legacy label must not read as a sandbox — that would let the
    // stale relay vouch for its own generation and never be collected.
    const containers = [
      sandbox('sandbox-p1', 'p1', 'new'),
      relay('relay-new', identity('p1', 'new')),
      {
        ...relay('relay-legacy', identity('p1', 'old')),
        labels: { 'verity.component': LEGACY_RELAY_COMPONENT, ...identity('p1', 'old') },
      },
    ];
    expect(planRelaySweep({ containers, nowMs: NOW_MS, minAgeMs })).toEqual([
      { id: 'relay-legacy', name: 'relay-legacy', projectId: 'p1', generation: 'old' },
    ]);
  });

  it('keeps a legacy-labelled relay whose generation a sandbox still uses', () => {
    const containers = [
      sandbox('sandbox-p1', 'p1', 'gen'),
      {
        ...relay('relay-legacy', identity('p1', 'gen')),
        labels: { 'verity.component': LEGACY_RELAY_COMPONENT, ...identity('p1', 'gen') },
      },
    ];
    expect(planRelaySweep({ containers, nowMs: NOW_MS, minAgeMs })).toEqual([]);
  });

  it('keeps a relay whose sandbox exists but is stopped', () => {
    // `listContainers` is the `all=true` listing, so a stopped sandbox is still
    // present — the reconciler can restart that generation.
    const containers = [
      sandbox('sandbox-p1', 'p1', 'gen'),
      relay('relay-gen', identity('p1', 'gen')),
    ];
    expect(planRelaySweep({ containers, nowMs: NOW_MS, minAgeMs })).toEqual([]);
  });

  it('scopes per project, so one project never evicts another', () => {
    const containers = [
      sandbox('sandbox-p1', 'p1', 'gen'),
      relay('relay-p1', identity('p1', 'gen')),
      relay('relay-p2', identity('p2', 'gen')), // same generation string, different project
    ];
    expect(planRelaySweep({ containers, nowMs: NOW_MS, minAgeMs }).map((r) => r.id)).toEqual([
      'relay-p2',
    ]);
  });

  it('never touches a foreign container or a relay missing an identity label', () => {
    const containers = [
      { id: 'foreign', imageId: 'sha256:x', names: ['postgres'], labels: {}, created: 0 },
      relay('relay-unstamped', { 'verity.project-id': 'p1' }), // no generation
      relay('relay-unowned', { 'verity.container-generation': 'gen' }), // no project id
    ];
    expect(planRelaySweep({ containers, nowMs: NOW_MS, minAgeMs })).toEqual([]);
  });

  it('respects the grace period around an in-flight provision', () => {
    // Relay up, sandbox not created yet — the provisioner may still be pulling.
    const containers = [relay('relay-young', identity('p1', 'gen'), secondsAgo(60_000))];
    expect(planRelaySweep({ containers, nowMs: NOW_MS, minAgeMs })).toEqual([]);
    expect(planRelaySweep({ containers, nowMs: NOW_MS, minAgeMs: 0 }).map((r) => r.id)).toEqual([
      'relay-young',
    ]);
  });

  it('keeps a relay this process still holds, however old it is', () => {
    // The gap neither existing guard can close, because the answer is not in the
    // listing: a provision started its relay and is still pulling the sandbox
    // image, so nothing on the daemon claims that generation. Age only makes the
    // collision unlikely — a stalled multi-GB pull outlasts any threshold — and
    // sweeping here deletes the relay the sandbox is about to be wired to.
    const ancient = relay('relay-held', identity('p1', 'gen'), secondsAgo(48 * 60 * 60_000));
    expect(
      planRelaySweep({ containers: [ancient], nowMs: NOW_MS, minAgeMs }).map((r) => r.id),
    ).toEqual(['relay-held']);
    expect(
      planRelaySweep({
        containers: [ancient],
        nowMs: NOW_MS,
        minAgeMs,
        held: [{ projectId: 'p1', containerGeneration: 'gen' }],
      }),
    ).toEqual([]);
  });

  it('holding one generation does not protect another of the same project', () => {
    // The hold is exact: a superseded relay must stay collectable while its
    // replacement is held, or a fleet that restarts daily never reclaims anything.
    const containers = [
      sandbox('sandbox-p1', 'p1', 'new'),
      relay('relay-new', identity('p1', 'new')),
      relay('relay-old', identity('p1', 'old')),
    ];
    expect(
      planRelaySweep({
        containers,
        nowMs: NOW_MS,
        minAgeMs,
        held: [{ projectId: 'p1', containerGeneration: 'new' }],
      }).map((r) => r.id),
    ).toEqual(['relay-old']);
  });

  it('skips a relay whose creation time the daemon did not report', () => {
    const ageless: DockerContainerSummary = {
      id: 'relay-ageless',
      imageId: 'sha256:relay',
      names: ['relay-ageless'],
      labels: { 'verity.component': RELAY_COMPONENT, ...identity('p1', 'gen') },
    };
    expect(planRelaySweep({ containers: [ageless], nowMs: NOW_MS, minAgeMs })).toEqual([]);
    expect(planRelaySweep({ containers: [ageless], nowMs: NOW_MS, minAgeMs: 0 })).toEqual([]);
  });
});

/** Assemble a DockerClient double plus spies over canned daemon state. */
function fakeDocker(state: {
  images?: DockerImageSummary[];
  containers?: DockerContainerSummary[];
  volumes?: DockerVolumeSummary[];
  removeImage?: (ref: string) => Promise<void>;
  removeVolume?: (name: string) => Promise<void>;
  stopContainer?: (id: string) => Promise<void>;
  removeContainer?: (id: string) => Promise<void>;
  pruneBuildCache?: (opts?: { untilHours?: number }) => Promise<number>;
}): DockerClient & {
  removedImages: string[];
  removedVolumes: string[];
  removedContainers: string[];
  stoppedContainers: string[];
  pruneCalls: Array<{ untilHours?: number } | undefined>;
} {
  const removedImages: string[] = [];
  const removedVolumes: string[] = [];
  const removedContainers: string[] = [];
  const stoppedContainers: string[] = [];
  const pruneCalls: Array<{ untilHours?: number } | undefined> = [];
  const client = {
    createContainer: () => Promise.reject(new Error('unused')),
    startContainer: () => Promise.reject(new Error('unused')),
    stopContainer: async (id: string) => {
      if (state.stopContainer) await state.stopContainer(id);
      stoppedContainers.push(id);
    },
    removeContainer: async (id: string) => {
      if (state.removeContainer) await state.removeContainer(id);
      removedContainers.push(id);
    },
    inspectContainer: () => Promise.reject(new Error('unused')),
    listImages: () => Promise.resolve(state.images ?? []),
    listContainers: () => Promise.resolve(state.containers ?? []),
    listVolumes: () => Promise.resolve(state.volumes ?? []),
    removeImage: async (ref: string) => {
      if (state.removeImage) await state.removeImage(ref);
      removedImages.push(ref);
    },
    removeVolume: async (name: string) => {
      if (state.removeVolume) await state.removeVolume(name);
      removedVolumes.push(name);
    },
    pruneBuildCache: async (opts?: { untilHours?: number }) => {
      pruneCalls.push(opts);
      return state.pruneBuildCache ? state.pruneBuildCache(opts) : 0;
    },
  } as unknown as DockerClient;
  return Object.assign(client, {
    removedImages,
    removedVolumes,
    removedContainers,
    stoppedContainers,
    pruneCalls,
  });
}

function deps(docker: DockerClient, overrides: Partial<DockerGcDeps> = {}): DockerGcDeps {
  return {
    docker,
    log: silentLog,
    now: () => Date.parse('2026-07-21T12:00:00Z'),
    freeBytes: () => Promise.resolve(500 * 1024 ** 3),
    ...overrides,
  };
}

describe('runDockerGc', () => {
  it('removes superseded images, dangling anonymous volumes, and old build cache', async () => {
    const docker = fakeDocker({
      images: [
        image({ id: 'sha256:new', repoTags: ['verity-devc-acme-web:a'], created: 300, size: 5 }),
        image({ id: 'sha256:old', repoTags: ['verity-devc-acme-web:b'], created: 100, size: 7 }),
      ],
      containers: [],
      volumes: [volume({ name: anonName('a'), createdAt: '2026-01-01T00:00:00Z' })],
      pruneBuildCache: () => Promise.resolve(1234),
    });
    const report = await runDockerGc(deps(docker, { policy: { keepImagesPerRepo: 1 } }));

    expect(docker.removedImages).toEqual(['verity-devc-acme-web:b']);
    expect(docker.removedVolumes).toEqual([anonName('a')]);
    expect(report).toMatchObject({
      imagesRemoved: ['verity-devc-acme-web:b'],
      estimatedImageBytes: 7,
      volumesRemoved: 1,
      buildCacheBytes: 1234,
      lowDisk: false,
      errors: [],
    });
  });

  it('sweeps orphaned builder state volumes alongside anonymous ones from one listing', async () => {
    const builderVol = 'buildx_buildkit_builder-4fd1fb8a-06b2_state';
    const docker = fakeDocker({
      volumes: [
        volume({ name: anonName('a'), createdAt: '2026-01-01T00:00:00Z' }),
        volume({ name: builderVol, createdAt: '2026-01-01T00:00:00Z' }),
      ],
    });
    const report = await runDockerGc(deps(docker));

    expect(docker.removedVolumes.sort()).toEqual([builderVol, anonName('a')].sort());
    expect(report.volumesRemoved).toBe(1);
    expect(report.builderVolumesRemoved).toBe(1);
  });

  it('leaves builder volumes alone when sweepOrphanedBuilderVolumes is off', async () => {
    const builderVol = 'buildx_buildkit_builder-4fd1fb8a-06b2_state';
    const docker = fakeDocker({
      volumes: [volume({ name: builderVol, createdAt: '2026-01-01T00:00:00Z' })],
    });
    const report = await runDockerGc(
      deps(docker, { policy: { sweepOrphanedBuilderVolumes: false } }),
    );

    expect(docker.removedVolumes).toEqual([]);
    expect(report.builderVolumesRemoved).toBe(0);
  });

  it('escalates to keeping one generation and no volume grace under disk pressure', async () => {
    const docker = fakeDocker({
      images: [
        image({ id: 'sha256:new', repoTags: ['verity-devc-acme-web:a'], created: 300 }),
        image({ id: 'sha256:old', repoTags: ['verity-devc-acme-web:b'], created: 100 }),
      ],
      // Minted seconds ago — spared by the normal policy, swept under pressure.
      volumes: [volume({ name: anonName('a'), createdAt: '2026-07-21T11:59:59Z' })],
    });
    const report = await runDockerGc(
      deps(docker, {
        freeBytes: () => Promise.resolve(1 * 1024 ** 3),
        policy: { keepImagesPerRepo: 2, lowDiskFreeBytes: 40 * 1024 ** 3 },
      }),
    );

    expect(report.lowDisk).toBe(true);
    expect(docker.removedImages).toEqual(['verity-devc-acme-web:b']);
    expect(docker.removedVolumes).toEqual([anonName('a')]);
  });

  it('skips a resource that fails and still sweeps the rest', async () => {
    const docker = fakeDocker({
      images: [
        image({ id: 'sha256:new', repoTags: ['verity-devc-acme-web:a'], created: 300 }),
        image({ id: 'sha256:busy', repoTags: ['verity-devc-acme-web:b'], created: 200 }),
        image({ id: 'sha256:old', repoTags: ['verity-devc-acme-web:c'], created: 100 }),
      ],
      volumes: [volume({ name: anonName('a'), createdAt: '2026-01-01T00:00:00Z' })],
      removeImage: (ref) =>
        ref === 'verity-devc-acme-web:b'
          ? Promise.reject(new Error('conflict: image is in use'))
          : Promise.resolve(),
    });
    const report = await runDockerGc(deps(docker, { policy: { keepImagesPerRepo: 1 } }));

    expect(report.imagesRemoved).toEqual(['verity-devc-acme-web:c']);
    expect(report.volumesRemoved).toBe(1);
    expect(report.errors).toEqual([
      { resource: 'image verity-devc-acme-web:b', message: 'conflict: image is in use' },
    ]);
  });

  it('does not sweep images at all when the in-use set cannot be read', async () => {
    // Without listContainers there is no way to know which image a live sandbox
    // runs on, so the image step must abstain rather than guess.
    const docker = fakeDocker({
      images: [
        image({ id: 'sha256:new', repoTags: ['verity-devc-acme-web:a'], created: 300 }),
        image({ id: 'sha256:old', repoTags: ['verity-devc-acme-web:b'], created: 100 }),
      ],
      volumes: [volume({ name: anonName('a'), createdAt: '2026-01-01T00:00:00Z' })],
    });
    const blind = { ...docker, listContainers: undefined } as unknown as DockerClient;
    const report = await runDockerGc(deps(blind, { policy: { keepImagesPerRepo: 1 } }));

    expect(report.imagesRemoved).toEqual([]);
    expect(report.volumesRemoved).toBe(1);
  });

  it('converts the build-cache max age into the daemon until filter', async () => {
    const docker = fakeDocker({});
    await runDockerGc(deps(docker, { policy: { buildCacheMaxAgeMs: 7 * 24 * 3_600_000 } }));
    expect(docker.pruneCalls).toEqual([{ untilHours: 168 }]);
  });

  it('skips the build-cache step when no max age is configured', async () => {
    const docker = fakeDocker({});
    await runDockerGc(deps(docker, { policy: { buildCacheMaxAgeMs: undefined } }));
    expect(docker.pruneCalls).toEqual([]);
  });

  it('runs the normal policy when free space cannot be probed', async () => {
    const docker = fakeDocker({
      images: [
        image({ id: 'sha256:new', repoTags: ['verity-devc-acme-web:a'], created: 300 }),
        image({ id: 'sha256:old', repoTags: ['verity-devc-acme-web:b'], created: 100 }),
      ],
    });
    const report = await runDockerGc(
      deps(docker, {
        freeBytes: () => Promise.resolve(undefined),
        policy: { keepImagesPerRepo: 2 },
      }),
    );
    expect(report.lowDisk).toBe(false);
    expect(report.imagesRemoved).toEqual([]);
  });
});

describe('runDockerGc relay sweep', () => {
  it('stops and removes a superseded relay, and reports it', async () => {
    const docker = fakeDocker({
      containers: [
        sandbox('sandbox-p1', 'p1', 'new'),
        relay('relay-new', identity('p1', 'new')),
        relay('relay-old', identity('p1', 'old')),
      ],
    });
    const report = await runDockerGc(deps(docker));

    expect(docker.stoppedContainers).toEqual(['relay-old']);
    expect(docker.removedContainers).toEqual(['relay-old']);
    expect(report.relaysRemoved).toEqual(['relay-old']);
    expect(report.errors).toEqual([]);
  });

  it('spares a relay a provision starts holding after the plan was built', async () => {
    // The plan is computed once, the removals follow one by one. The hold is taken
    // here strictly BETWEEN two removals, so the plan-time check cannot have seen
    // it — only the per-removal re-read spares `relay-b`. Re-listing containers
    // would not help either: a provision that has not created its sandbox yet is
    // invisible in the listing.
    const held: Array<{ projectId: string; containerGeneration: string }> = [];
    const docker = fakeDocker({
      containers: [
        relay('relay-a', identity('p1', 'old')),
        relay('relay-b', identity('p2', 'old')),
      ],
      removeContainer: (id) => {
        if (id === 'relay-a') held.push({ projectId: 'p2', containerGeneration: 'old' });
        return Promise.resolve();
      },
    });
    const report = await runDockerGc(deps(docker, { heldRelays: () => held }));

    expect(docker.removedContainers).toEqual(['relay-a']);
    expect(report.relaysRemoved).toEqual(['relay-a']);
    expect(report.errors).toEqual([]);
  });

  it('leaves relays alone when the policy disables the sweep', async () => {
    const docker = fakeDocker({
      containers: [relay('relay-old', identity('p1', 'old'))],
    });
    const report = await runDockerGc(deps(docker, { policy: { sweepSupersededRelays: false } }));

    expect(docker.removedContainers).toEqual([]);
    expect(report.relaysRemoved).toEqual([]);
  });

  it('revalidates that no matching sandbox appeared before removing a relay', async () => {
    const oldRelay = relay('relay-old', identity('p1', 'old'));
    const docker = fakeDocker({ containers: [oldRelay] });
    const listContainers = vi.spyOn(docker, 'listContainers');
    listContainers
      .mockResolvedValueOnce([oldRelay])
      .mockResolvedValueOnce([oldRelay])
      .mockResolvedValueOnce([oldRelay, sandbox('sandbox-old', 'p1', 'old')]);

    const report = await runDockerGc(deps(docker));

    expect(docker.stoppedContainers).toEqual([]);
    expect(docker.removedContainers).toEqual([]);
    expect(report.relaysRemoved).toEqual([]);
  });

  it('still removes an already-stopped relay when stopping it fails', async () => {
    const docker = fakeDocker({
      containers: [relay('relay-old', identity('p1', 'old'))],
      stopContainer: () => Promise.reject(new Error('container is not running')),
    });
    const report = await runDockerGc(deps(docker));

    expect(docker.removedContainers).toEqual(['relay-old']);
    expect(report.relaysRemoved).toEqual(['relay-old']);
    expect(report.errors).toEqual([]);
  });

  it('treats a relay disappearing before removal as already collected', async () => {
    const docker = fakeDocker({
      containers: [relay('relay-old', identity('p1', 'old'))],
      removeContainer: () =>
        Promise.reject(
          new DockerError({
            kind: 'container_not_found',
            id: 'relay-old',
          }),
        ),
    });
    const report = await runDockerGc(deps(docker));

    expect(report.relaysRemoved).toEqual(['relay-old']);
    expect(report.errors).toEqual([]);
  });

  it('skips a relay whose removal fails and keeps sweeping the rest', async () => {
    const docker = fakeDocker({
      containers: [
        relay('relay-a', identity('p1', 'old')),
        relay('relay-b', identity('p2', 'old')),
      ],
      removeContainer: (id) =>
        id === 'relay-a' ? Promise.reject(new Error('daemon busy')) : Promise.resolve(),
    });
    const report = await runDockerGc(deps(docker));

    expect(report.relaysRemoved).toEqual(['relay-b']);
    expect(report.errors).toEqual([{ resource: 'relay relay-a', message: 'daemon busy' }]);
  });
});

describe('startDockerGcScheduler', () => {
  it('runs a delayed boot pass and reschedules, and stop() cancels it', async () => {
    vi.useFakeTimers();
    try {
      const docker = fakeDocker({
        volumes: [volume({ name: anonName('a'), createdAt: '2026-01-01T00:00:00Z' })],
      });
      const scheduler = startDockerGcScheduler(deps(docker));

      expect(docker.removedVolumes).toEqual([]);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(docker.removedVolumes).toEqual([anonName('a')]);

      scheduler.stop();
      // A full day later the cancelled timer must not fire another pass.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(docker.removedVolumes).toEqual([anonName('a')]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes runOnce as a timer-free seam', async () => {
    vi.useFakeTimers();
    try {
      const docker = fakeDocker({
        volumes: [volume({ name: anonName('a'), createdAt: '2026-01-01T00:00:00Z' })],
      });
      const scheduler = startDockerGcScheduler(deps(docker));
      const report = await scheduler.runOnce();
      scheduler.stop();
      expect(report.volumesRemoved).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DEFAULT_DOCKER_GC_POLICY', () => {
  it('keeps more than one generation so an in-flight provision still hits cache', () => {
    expect(DEFAULT_DOCKER_GC_POLICY.keepImagesPerRepo).toBeGreaterThan(1);
    expect(DEFAULT_DOCKER_GC_POLICY.lowDiskKeepImagesPerRepo).toBeGreaterThanOrEqual(1);
  });

  it('sweeps superseded relays by default, behind a grace period', () => {
    expect(DEFAULT_DOCKER_GC_POLICY.sweepSupersededRelays).toBe(true);
    expect(DEFAULT_DOCKER_GC_POLICY.relayMinAgeMs).toBeGreaterThan(0);
  });
});
