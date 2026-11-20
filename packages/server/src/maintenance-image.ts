import { randomUUID } from 'node:crypto';
import { DockerError, type DockerClient, type DockerImageIdentity } from './docker.js';
import type { DerivedImageReferences } from './derived-image-references.js';

export class MaintenanceImageError extends Error {
  constructor(
    readonly code:
      | 'image-unavailable'
      | 'image-preparation-failed'
      | 'image-preparation-timeout'
      | 'image-preparation-cancelled',
  ) {
    super(`Maintenance image: ${code}`);
  }
}
interface Preparation {
  promise: Promise<DockerImageIdentity>;
}

/** Bound for one download, independent of any caller's wait. */
const PULL_BUDGET_MS = 30 * 60_000;

/** Reserve against GC from inspection through helper use; never own a project's reservations. */
export class MaintenanceImages {
  private readonly shutdown = new AbortController();
  private readonly preparations = new Map<string, Preparation>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly docker: DockerClient,
    private readonly references: Pick<DerivedImageReferences, 'reserve' | 'releaseProject'>,
  ) {}

  abort(): void {
    this.shutdown.abort();
  }

  async withImage<T>(
    ref: string,
    operation: (image: DockerImageIdentity, recheck: () => Promise<void>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lifetime = AbortSignal.any([
      this.shutdown.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    const owner = `maintenance-${randomUUID()}`;
    // A pull accepts repository digests only, never mutable tags or arbitrary image IDs.
    if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/u.test(ref))
      throw new MaintenanceImageError('image-unavailable');
    let using = false;
    try {
      if (lifetime.aborted) throw new MaintenanceImageError('image-preparation-cancelled');
      await this.references.reserve(owner, ref);
      const image = await this.prepare(ref, lifetime);
      await this.references.reserve(owner, image.id);
      const recheck = async () => {
        if (this.shutdown.signal.aborted || signal?.aborted)
          throw new MaintenanceImageError('image-preparation-cancelled');
        const current = await this.docker.inspectImageIdentity?.(ref).catch(() => {
          throw new MaintenanceImageError('image-preparation-failed');
        });
        if (!current || current.id !== image.id || !current.repoDigests.includes(ref))
          throw new MaintenanceImageError('image-unavailable');
      };
      await recheck();
      if (lifetime.aborted)
        throw new MaintenanceImageError(
          lifetime.reason instanceof DOMException && lifetime.reason.name === 'TimeoutError'
            ? 'image-preparation-timeout'
            : 'image-preparation-cancelled',
        );
      using = true;
      return await operation(image, recheck);
    } catch (error) {
      if (using || error instanceof MaintenanceImageError) throw error;
      throw new MaintenanceImageError(
        error instanceof DockerError && (error.kind === 'timeout' || error.kind === 'pull_stalled')
          ? 'image-preparation-timeout'
          : 'image-preparation-failed',
      );
    } finally {
      await this.references.releaseProject(owner);
    }
  }

  /**
   * One download per digest, owned by the preparation rather than by its
   * callers. A caller's 30 s wait is far shorter than a sandbox image takes to
   * download, and cancelling the download when the last caller gave up meant no
   * attempt ever completed: each restarted it, and every cancelled download left
   * its partial layers leased on the disk for hours. The download now finishes
   * under its own image reservation, so a later attempt finds the image present;
   * only shutdown or {@link PULL_BUDGET_MS} stops it.
   */
  private async prepare(ref: string, signal: AbortSignal): Promise<DockerImageIdentity> {
    let preparation = this.preparations.get(ref);
    if (!preparation) {
      const controller = new AbortController();
      const stop = () => controller.abort(this.shutdown.signal.reason);
      this.shutdown.signal.addEventListener('abort', stop, { once: true });
      if (this.shutdown.signal.aborted) stop();
      const budget = setTimeout(
        () => controller.abort(new DOMException('Download budget exceeded', 'TimeoutError')),
        PULL_BUDGET_MS,
      );
      budget.unref?.();
      const owner = `maintenance-download-${randomUUID()}`;
      let reserved = false;
      const previous = this.tail;
      const promise = previous
        .then(async () => {
          controller.signal.throwIfAborted();
          const existing = await this.docker.inspectImageIdentity?.(ref);
          if (existing) {
            if (!existing.repoDigests.includes(ref))
              throw new MaintenanceImageError('image-unavailable');
            return existing;
          }
          if (!this.docker.pullImage || !this.docker.inspectImageIdentity)
            throw new MaintenanceImageError('image-unavailable');
          controller.signal.throwIfAborted();
          // Held until the download settles, whether or not any caller still waits.
          reserved = true;
          await this.references.reserve(owner, ref);
          await this.docker.pullImage(ref, { signal: controller.signal });
          controller.signal.throwIfAborted();
          const image = await this.docker.inspectImageIdentity(ref);
          if (!image || !image.repoDigests.includes(ref))
            throw new MaintenanceImageError('image-unavailable');
          return image;
        })
        .finally(async () => {
          clearTimeout(budget);
          this.shutdown.signal.removeEventListener('abort', stop);
          if (reserved) await this.references.releaseProject(owner);
        });
      preparation = { promise };
      this.preparations.set(ref, preparation);
      const entry = preparation;
      this.tail = promise.catch(() => undefined);
      void promise
        .finally(() => {
          if (this.preparations.get(ref) === entry) this.preparations.delete(ref);
        })
        .catch(() => undefined);
    }
    const entry = preparation;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          new MaintenanceImageError(
            signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
              ? 'image-preparation-timeout'
              : 'image-preparation-cancelled',
          ),
        );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      return await Promise.race([entry.promise, cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
