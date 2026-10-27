import { restoreComposeDatabaseVolume } from './restore-compose-volume.js';
import { join } from 'node:path';
import type { DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
import type { RestorePreviousInstallation } from './restore-promotion.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import { copyRestoreVolume } from './restore-volume-copy.js';
import { publishRestoreHostState, saveRestoreHostState } from './restore-host-state.js';

/** Called under the installer lease after all previous writers have been durably stopped. */
export class RestorePromotionStorage {
  constructor(
    private readonly options: {
      docker: DockerClient;
      job: RestoreJob;
      root: string;
      hostRoot: string;
    },
  ) {}

  private async volumes(previous: RestorePreviousInstallation) {
    const resources = restoreDatabaseResources(this.options.job);
    return [
      {
        live: 'verity-data',
        saved: resources.prefix + '-previous-data',
        staged: resources.prefix + '-data',
        existed: previous.dataVolume,
      },
      {
        live: await restoreComposeDatabaseVolume(this.options.root, this.options.job),
        saved: resources.prefix + '-previous-db',
        staged: resources.volume,
        existed: previous.databaseVolume,
      },
      {
        live: 'verity-managed-deployment',
        saved: resources.prefix + '-previous-managed',
        staged: resources.prefix + '-managed',
        existed: previous.managedVolume,
      },
    ];
  }

  private async ensureOwned(name: string): Promise<void> {
    const { docker, job } = this.options;
    if (!docker.ensureVolume || !docker.listVolumes)
      throw new Error('Restore volume inspection unavailable');
    const labels = restoreDatabaseResources(job).labels;
    await docker.ensureVolume(name, { labels });
    const volume = (await docker.listVolumes()).find((volume) => volume.name === name);
    if (volume?.labels['verity.restore-job'] !== job.id)
      throw new Error('Restore checkpoint volume ownership mismatch');
  }

  async save(previous: RestorePreviousInstallation, signal?: AbortSignal): Promise<void> {
    const { job, root, hostRoot } = this.options;
    signal?.throwIfAborted();
    await saveRestoreHostState(hostRoot, join(root, job.id, 'previous-host'), job.id);
    for (const volume of await this.volumes(previous)) {
      signal?.throwIfAborted();
      if (!volume.existed) continue;
      await this.ensureOwned(volume.saved);
      await copyRestoreVolume({
        ...this.options,
        source: volume.live,
        destination: volume.saved,
        ...(signal ? { signal } : {}),
      });
    }
    // A fresh managed bootstrap must not reuse the old installation's update journal.
    await this.ensureOwned(restoreDatabaseResources(job).prefix + '-managed');
  }

  async publish(previous: RestorePreviousInstallation, signal?: AbortSignal): Promise<void> {
    const { docker, job, root, hostRoot } = this.options;
    if (!docker.listVolumes) throw new Error('Restore volume inspection unavailable');
    for (const volume of await this.volumes(previous)) {
      signal?.throwIfAborted();
      if (!volume.existed) await this.ensureOwned(volume.live);
      await copyRestoreVolume({
        ...this.options,
        source: volume.staged,
        destination: volume.live,
        ...(signal ? { signal } : {}),
      });
    }
    signal?.throwIfAborted();
    await publishRestoreHostState(join(root, job.id, 'host'), hostRoot);
  }

  async rollback(previous: RestorePreviousInstallation, signal?: AbortSignal): Promise<void> {
    const { docker, job, root, hostRoot } = this.options;
    if (!docker.listVolumes || !docker.removeVolume)
      throw new Error('Restore volume cleanup unavailable');
    const volumes = await docker.listVolumes();
    // Validate the entire rollback source before changing canonical volumes.
    for (const volume of await this.volumes(previous)) {
      const source = volumes.find(
        (candidate) => candidate.name === (volume.existed ? volume.saved : volume.live),
      );
      if ((volume.existed && !source) || (source && source.labels['verity.restore-job'] !== job.id))
        throw new Error('Restore rollback volume ownership mismatch');
    }
    for (const volume of await this.volumes(previous)) {
      signal?.throwIfAborted();
      if (volume.existed)
        await copyRestoreVolume({
          ...this.options,
          source: volume.saved,
          destination: volume.live,
          ...(signal ? { signal } : {}),
        });
      else if (volumes.some((candidate) => candidate.name === volume.live))
        await docker.removeVolume(volume.live);
    }
    signal?.throwIfAborted();
    await publishRestoreHostState(join(root, job.id, 'previous-host'), hostRoot, job.id);
  }
}
