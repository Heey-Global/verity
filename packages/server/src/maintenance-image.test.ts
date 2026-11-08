import { describe, expect, it, vi } from 'vitest';
import type { DockerClient, DockerImageIdentity, DockerImageSummary } from './docker.js';
import { DerivedImageReferences } from './derived-image-references.js';
import { planImageSweep } from './docker-gc.js';
import { MaintenanceImages } from './maintenance-image.js';

const ref = `ghcr.io/example/sandbox@sha256:${'a'.repeat(64)}`;
const otherRef = `ghcr.io/example/sandbox@sha256:${'b'.repeat(64)}`;
const identity = (digest = ref): DockerImageIdentity => ({
  id: `sha256:${(digest === ref ? 'c' : 'd').repeat(64)}`,
  repoDigests: [digest],
  sizeBytes: 100,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const images = new Map<string, DockerImageIdentity>();
  const held = new Map<string, Set<string>>();
  const reserve = vi.fn(async (owner: string, image: string) => {
    const refs = held.get(owner) ?? new Set<string>();
    refs.add(image);
    held.set(owner, refs);
  });
  const releaseProject = vi.fn(async (owner: string) => {
    held.delete(owner);
  });
  const inspectImageIdentity = vi.fn(async (digest: string) => images.get(digest));
  const pullImage = vi.fn(async (digest: string, options?: { signal?: AbortSignal }) => {
    options?.signal?.throwIfAborted();
    images.set(digest, identity(digest));
  });
  const docker = { inspectImageIdentity, pullImage } as unknown as DockerClient;
  return {
    images,
    held,
    reserve,
    releaseProject,
    inspectImageIdentity,
    pullImage,
    maintenance: new MaintenanceImages(docker, { reserve, releaseProject }),
  };
}

describe('maintenance image preparation', () => {
  it('uses an existing verified image without pulling and reserves it through helper use', async () => {
    const h = fixture();
    h.images.set(ref, identity());
    await h.maintenance.withImage(ref, async (image, recheck) => {
      expect(image).toEqual(identity());
      expect([...h.held.values()].some((refs) => refs.has(ref) && refs.has(image.id))).toBe(true);
      await recheck();
      expect(h.releaseProject).not.toHaveBeenCalled();
    });
    expect(h.pullImage).not.toHaveBeenCalled();
    expect(h.held.size).toBe(0);
    expect(h.releaseProject).toHaveBeenCalledTimes(1);
  });

  it('downloads the selected missing digest and verifies it before admitting the helper', async () => {
    const h = fixture();
    const operation = vi.fn(async (image: DockerImageIdentity) => image.id);
    await expect(h.maintenance.withImage(ref, operation)).resolves.toBe(identity().id);
    expect(h.pullImage).toHaveBeenCalledExactlyOnceWith(ref, { signal: expect.any(AbortSignal) });
    expect(h.inspectImageIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      h.pullImage.mock.invocationCallOrder[0]!,
    );
    expect(h.inspectImageIdentity.mock.invocationCallOrder.at(-1)).toBeLessThan(
      operation.mock.invocationCallOrder[0]!,
    );
    expect(h.held.size).toBe(0);
  });

  it.each(['ghcr.io/example/sandbox:latest', `sha256:${'a'.repeat(64)}`])(
    'refuses an unpinned repository reference %s',
    async (invalid) => {
      const h = fixture();
      await expect(h.maintenance.withImage(invalid, async () => undefined)).rejects.toMatchObject({
        code: 'image-unavailable',
      });
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.pullImage).not.toHaveBeenCalled();
    },
  );

  it.each(['existing', 'downloaded'])(
    'refuses a mismatched digest in the %s image',
    async (source) => {
      const h = fixture();
      if (source === 'existing') h.images.set(ref, identity(otherRef));
      else
        h.pullImage.mockImplementation(async () => {
          h.images.set(ref, identity(otherRef));
        });
      const operation = vi.fn();
      await expect(h.maintenance.withImage(ref, operation)).rejects.toMatchObject({
        code: 'image-unavailable',
      });
      expect(operation).not.toHaveBeenCalled();
      expect(h.held.size).toBe(0);
    },
  );

  it('redacts pull failures and permits a subsequent retry', async () => {
    const h = fixture();
    h.pullImage.mockRejectedValueOnce(new Error('registry rejected secret-token'));
    const failure = h.maintenance.withImage(ref, async () => undefined);
    await expect(failure).rejects.toMatchObject({
      code: 'image-preparation-failed',
      message: 'Maintenance image: image-preparation-failed',
    });
    expect(h.held.size).toBe(0);
    await expect(h.maintenance.withImage(ref, async (image) => image.id)).resolves.toBe(
      identity().id,
    );
    expect(h.pullImage).toHaveBeenCalledTimes(2);
  });

  it('shares one in-progress download between callers while retaining independent leases', async () => {
    const h = fixture();
    const download = deferred();
    h.pullImage.mockImplementation(async (digest) => {
      await download.promise;
      h.images.set(digest, identity(digest));
    });
    const first = h.maintenance.withImage(ref, async (image) => image.id);
    const second = h.maintenance.withImage(ref, async (image) => image.id);
    await vi.waitFor(() => expect(h.pullImage).toHaveBeenCalledTimes(1));
    expect(h.held.size).toBe(2);
    download.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([identity().id, identity().id]);
    expect(h.pullImage).toHaveBeenCalledTimes(1);
    expect(h.held.size).toBe(0);
  });

  it('serializes downloads of different digests', async () => {
    const h = fixture();
    const download = deferred();
    h.pullImage.mockImplementation(async (digest) => {
      if (digest === ref) await download.promise;
      h.images.set(digest, identity(digest));
    });
    const first = h.maintenance.withImage(ref, async () => undefined);
    await vi.waitFor(() => expect(h.pullImage).toHaveBeenCalledTimes(1));
    const second = h.maintenance.withImage(otherRef, async () => undefined);
    await vi.waitFor(() => expect(h.held.size).toBe(2));
    expect(h.pullImage).toHaveBeenCalledTimes(1);
    download.resolve();
    await Promise.all([first, second]);
    expect(h.pullImage.mock.calls.map(([digest]) => digest)).toEqual([ref, otherRef]);
  });

  it('does not cancel a shared download when only one caller aborts', async () => {
    const h = fixture();
    const download = deferred();
    h.pullImage.mockImplementation(async (digest) => {
      await download.promise;
      h.images.set(digest, identity(digest));
    });
    const controller = new AbortController();
    const first = h.maintenance.withImage(ref, async () => undefined, controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: 'image-preparation-cancelled' });
    const second = h.maintenance.withImage(ref, async (image) => image.id);
    await vi.waitFor(() => expect(h.held.size).toBe(2));
    await vi.waitFor(() => expect(h.pullImage).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(h.pullImage.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    expect(h.held.size).toBe(1);
    download.resolve();
    await expect(second).resolves.toBe(identity().id);
    expect(h.held.size).toBe(0);
  });

  it('keeps the final lease until a cancelled pull actually settles', async () => {
    const h = fixture();
    const download = deferred();
    h.pullImage.mockImplementationOnce(async () => {
      await download.promise;
    });
    const controller = new AbortController();
    const operation = vi.fn();
    const preparation = h.maintenance.withImage(ref, operation, controller.signal);
    const rejected = expect(preparation).rejects.toMatchObject({
      code: 'image-preparation-cancelled',
    });
    await vi.waitFor(() => expect(h.pullImage).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.waitFor(() => expect(h.pullImage.mock.calls[0]![1]!.signal!.aborted).toBe(true));
    expect(h.releaseProject).not.toHaveBeenCalled();
    expect(h.held.size).toBe(1);
    download.resolve();
    await rejected;
    expect(h.held.size).toBe(0);
    expect(operation).not.toHaveBeenCalled();
    await expect(h.maintenance.withImage(ref, async (image) => image.id)).resolves.toBe(
      identity().id,
    );
  });

  it('reports timeout separately and retains its lease until the pull settles', async () => {
    const h = fixture();
    const timeout = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const download = deferred();
    h.pullImage.mockImplementationOnce(async () => {
      await download.promise;
    });
    try {
      const result = h.maintenance.withImage(ref, async () => undefined);
      const rejected = expect(result).rejects.toMatchObject({ code: 'image-preparation-timeout' });
      await vi.waitFor(() => expect(h.pullImage).toHaveBeenCalledTimes(1));
      timeout.abort(new DOMException('Timed out', 'TimeoutError'));
      await vi.waitFor(() => expect(h.pullImage.mock.calls[0]![1]!.signal!.aborted).toBe(true));
      expect(h.held.size).toBe(1);
      download.resolve();
      await rejected;
      expect(h.held.size).toBe(0);
    } finally {
      download.resolve();
      timer.mockRestore();
    }
  });

  it('cancels active and queued preparation on shutdown without admitting helpers', async () => {
    const h = fixture();
    const download = deferred();
    h.pullImage.mockImplementationOnce(async () => {
      await download.promise;
    });
    const operation = vi.fn();
    const first = h.maintenance.withImage(ref, operation);
    const firstRejected = expect(first).rejects.toMatchObject({
      code: 'image-preparation-cancelled',
    });
    await vi.waitFor(() => expect(h.pullImage).toHaveBeenCalledTimes(1));
    const second = h.maintenance.withImage(otherRef, operation);
    const secondRejected = expect(second).rejects.toMatchObject({
      code: 'image-preparation-cancelled',
    });
    await vi.waitFor(() => expect(h.held.size).toBe(2));
    h.maintenance.abort();
    await vi.waitFor(() => expect(h.pullImage.mock.calls[0]![1]!.signal!.aborted).toBe(true));
    expect(h.held.size).toBe(2);
    download.resolve();
    await Promise.all([firstRejected, secondRejected]);
    expect(h.pullImage).toHaveBeenCalledTimes(1);
    expect(h.held.size).toBe(0);
    expect(operation).not.toHaveBeenCalled();
    await expect(h.maintenance.withImage(ref, operation)).rejects.toMatchObject({
      code: 'image-preparation-cancelled',
    });
  });

  it('preserves helper operation failures instead of reporting an image failure', async () => {
    const h = fixture();
    h.images.set(ref, identity());
    const failure = new Error('Helper rejected unsafe storage');
    await expect(
      h.maintenance.withImage(ref, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(h.held.size).toBe(0);
  });

  it('protects the image during pull and helper use without releasing project reservations', async () => {
    const h = fixture();
    const releaseRef = `ghcr.io/heey-global/verity/verity-sandbox@sha256:${'a'.repeat(64)}`;
    const projectRef = 'verity-devc-existing-project:in-flight';
    const references = new DerivedImageReferences(async () => ({
      refs: new Set(),
      repositories: new Set(),
    }));
    const image: DockerImageSummary = {
      id: identity(releaseRef).id,
      repoTags: [],
      repoDigests: [releaseRef],
      labels: {},
      created: 0,
      size: 100,
    };
    const plan = () =>
      references.withSnapshot(async (projectImages) =>
        planImageSweep({
          images: [image],
          inUseImageIds: new Set(),
          keepPerRepo: 0,
          keepReleaseImagesPerRepo: 0,
          projectImages,
        }),
      );
    // Make the fixture independently eligible: otherwise a lease test could pass on retention alone.
    expect((await plan()).map((entry) => entry.imageId)).toEqual([image.id]);
    await references.reserve('existing-project', projectRef);
    const docker = {
      inspectImageIdentity: h.inspectImageIdentity,
      pullImage: h.pullImage,
    } as unknown as DockerClient;
    const maintenance = new MaintenanceImages(docker, references);
    h.pullImage.mockImplementation(async (digest) => {
      expect(await plan()).toEqual([]);
      h.images.set(digest, { ...identity(digest), id: image.id });
    });
    await maintenance.withImage(releaseRef, async () => {
      expect(await plan()).toEqual([]);
      await references.withSnapshot(async (snapshot) => {
        expect(snapshot.refs.has(releaseRef)).toBe(true);
        expect(snapshot.refs.has(image.id)).toBe(true);
        expect(snapshot.refs.has(projectRef)).toBe(true);
      });
    });
    await references.withSnapshot(async (snapshot) => {
      expect([...snapshot.refs]).toEqual([projectRef]);
    });
    expect((await plan()).map((entry) => entry.imageId)).toEqual([image.id]);
    await references.releaseProject('existing-project');
  });

  it('refuses helper creation when image availability changes while waiting for a project barrier', async () => {
    const h = fixture();
    h.images.set(ref, identity());
    const waiting = deferred();
    const barrier = deferred();
    const createHelper = vi.fn();
    const using = h.maintenance.withImage(ref, async (_image, recheck) => {
      waiting.resolve();
      await barrier.promise;
      await recheck();
      createHelper();
    });
    const rejected = expect(using).rejects.toMatchObject({ code: 'image-unavailable' });
    await waiting.promise;
    h.images.delete(ref);
    barrier.resolve();
    await rejected;
    expect(createHelper).not.toHaveBeenCalled();
    expect(h.held.size).toBe(0);
  });

  it('rechecks image identity before later helper creation', async () => {
    const h = fixture();
    h.images.set(ref, identity());
    await h.maintenance.withImage(ref, async (_image, recheck) => {
      h.images.set(ref, { ...identity(), id: `sha256:${'e'.repeat(64)}` });
      await expect(recheck()).rejects.toMatchObject({ code: 'image-unavailable' });
    });
    expect(h.held.size).toBe(0);
  });
});
