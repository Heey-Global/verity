import { createTestDb } from '@verity/store/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  DerivedImageReferences,
  createProjectImageReferences,
} from './derived-image-references.js';
import { planImageSweep, runDockerGc } from './docker-gc.js';
import type { DockerClient, DockerImageSummary } from './docker.js';

const ref = 'verity-devc-org-repo:hash';
const image: DockerImageSummary = {
  id: 'sha256:test',
  repoTags: [ref],
  repoDigests: [],
  labels: {},
  created: 1,
  size: 100,
};
const log = { info: vi.fn(), warn: vi.fn() };
const snapshot = (refs: string[] = [], repositories: string[] = []) => ({
  refs: new Set(refs),
  repositories: new Set(repositories),
});
describe('derived project image lifetime', () => {
  it('collects every deleted-project generation, retaining shared selections and stopped containers', () => {
    expect(
      planImageSweep({
        images: [image],
        inUseImageIds: new Set(),
        keepPerRepo: 2,
        projectImages: snapshot(),
      }),
    ).toHaveLength(1);
    expect(
      planImageSweep({
        images: [image],
        inUseImageIds: new Set(),
        keepPerRepo: 0,
        projectImages: snapshot([ref]),
      }),
    ).toEqual([]);
    expect(
      planImageSweep({
        images: [image],
        inUseImageIds: new Set([image.id]),
        keepPerRepo: 0,
        projectImages: snapshot(),
      }),
    ).toEqual([]);
  });
  it('holds a project image from before build/import until its provisioning finishes', async () => {
    const references = new DerivedImageReferences(async () => snapshot());
    await references.reserve('deleted-project', ref);
    await references.reserve('shared-project', ref);
    await references.releaseProject('deleted-project');
    await references.withSnapshot(async (held) => {
      expect(held.refs.has(ref)).toBe(true);
    });
    await references.releaseProject('shared-project');
    await references.withSnapshot(async (held) => {
      expect(held.refs.has(ref)).toBe(false);
    });
  });
  it('serializes a new reservation behind deletion so its cache check sees the completed removal', async () => {
    const references = new DerivedImageReferences(async () => snapshot());
    let finish!: () => void;
    let entered!: () => void;
    const deleting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const removed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sweep = references.withSnapshot(async () => {
      entered();
      await removed;
    });
    await deleting;
    let reserved = false;
    const reserve = references.reserve('project', ref).then(() => {
      reserved = true;
    });
    await Promise.resolve();
    expect(reserved).toBe(false);
    finish();
    await sweep;
    await reserve;
    expect(reserved).toBe(true);
  });
  it('fails closed when persisted references cannot be read, then retries collection failures', async () => {
    const read = vi.fn(async () => snapshot());
    read.mockRejectedValueOnce(new Error('database unavailable'));
    const references = new DerivedImageReferences(read);
    const removeImage = vi
      .fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(undefined);
    const docker = {
      listImages: async () => [image],
      listContainers: async () => [],
      removeImage,
    } as unknown as DockerClient;
    const deps = { docker, log, imagesOnly: true, imageReferences: references };
    expect((await runDockerGc(deps)).errors).toHaveLength(1);
    expect(removeImage).not.toHaveBeenCalled();
    expect((await runDockerGc(deps)).errors).toHaveLength(1);
    expect((await runDockerGc(deps)).imagesRemoved).toEqual([ref]);
    expect(removeImage).toHaveBeenCalledTimes(2);
  });
  it('protects a container that appeared after planning', async () => {
    const listContainers = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ imageId: image.id }]);
    const removeImage = vi.fn();
    const docker = {
      listImages: async () => [image],
      listContainers,
      removeImage,
    } as unknown as DockerClient;
    const result = await runDockerGc({
      docker,
      log,
      imagesOnly: true,
      imageReferences: new DerivedImageReferences(async () => snapshot()),
    });
    expect(result.imagesRemoved).toEqual([]);
    expect(removeImage).not.toHaveBeenCalled();
  });
});

it('reads durable project selections after restart and drops only hidden project references', async () => {
  const ctx = await createTestDb();
  try {
    for (const id of ['first', 'shared']) {
      await ctx.store.upsertProject({
        id,
        owner: 'org',
        repo: id,
        containerName: `dev-${id}`,
        state: 'absent',
      });
      await ctx.db
        .updateTable('projects')
        .set({ image_ref: ref, image_override_ref: 'verity-devc-other-repo:chosen' })
        .where('id', '=', id)
        .execute();
    }
    await ctx.store.hideProject('first');
    const restarted = createProjectImageReferences(ctx.db);
    await restarted.withSnapshot(async (held) => {
      expect(held.refs).toEqual(new Set([ref, 'verity-devc-other-repo:chosen']));
      expect(held.repositories).toEqual(new Set(['verity-devc-org-shared']));
    });
    await ctx.store.hideProject('shared');
    await restarted.withSnapshot(async (held) => {
      expect(held.refs.size).toBe(0);
      expect(held.repositories.size).toBe(0);
    });
  } finally {
    await ctx.close();
  }
});

it.each(['sha256:test', 'private.example/probe@sha256:pinned'])(
  'protects project selections by content id or digest (%s)',
  (selected) => {
    expect(
      planImageSweep({
        images: [{ ...image, repoDigests: ['private.example/probe@sha256:pinned'] }],
        inUseImageIds: new Set(),
        keepPerRepo: 0,
        projectImages: snapshot([selected]),
      }),
    ).toEqual([]);
  },
);
