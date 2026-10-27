import type { DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
import type { RestorePreviousInstallation } from './restore-promotion.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';

/** Freeze names, restart policies and running intent before touching any previous container. */
export class RestorePreviousRuntime {
  constructor(
    private readonly options: {
      docker: DockerClient;
      job: Pick<RestoreJob, 'id'>;
      composeProject: string;
      databaseVolume: string;
    },
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.composeProject))
      throw new Error('Invalid previous Compose project');
    if (!/^[a-z0-9][a-z0-9_-]{0,127}_verity-db$/.test(options.databaseVolume))
      throw new Error('Invalid restored database volume');
  }

  async inspect(hostConfiguration: boolean): Promise<RestorePreviousInstallation> {
    const { docker, job, composeProject } = this.options;
    if (!docker.listContainers || !docker.listVolumes)
      throw new Error('Previous installation inspection unavailable');
    const VOLUMES = ['verity-data', this.options.databaseVolume, 'verity-managed-deployment'];
    const containers: RestorePreviousInstallation['containers'] = [];
    for (const candidate of await docker.listContainers()) {
      if (candidate.labels?.['verity.restore-job'] === job.id) continue;
      const inspected = await docker.inspectContainer(candidate.id);
      if (
        candidate.labels?.['com.docker.compose.project'] !== composeProject &&
        !inspected.mounts?.some(
          (mount) => mount.type === 'volume' && VOLUMES.includes(mount.name ?? ''),
        )
      )
        continue;
      const name = candidate.names?.[0];
      const policy = inspected.restartPolicy;
      const count = inspected.restartMaximumRetryCount;
      if (
        !/^[a-f0-9]{64}$/.test(candidate.id) ||
        inspected.id !== candidate.id ||
        candidate.names?.length !== 1 ||
        !name ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(name) ||
        !['no', 'always', 'unless-stopped', 'on-failure'].includes(policy ?? '') ||
        !Number.isSafeInteger(count) ||
        count! < 0
      )
        throw new Error('Previous container cannot be safely retained');
      containers.push({
        id: candidate.id,
        name,
        running: inspected.running,
        restartPolicy: policy as 'no' | 'always' | 'unless-stopped' | 'on-failure',
        maximumRetryCount: count!,
      });
    }
    containers.sort((a, b) => a.id.localeCompare(b.id));
    const volumes = await docker.listVolumes();
    return {
      containers,
      dataVolume: volumes.some((volume) => volume.name === VOLUMES[0]),
      databaseVolume: volumes.some((volume) => volume.name === VOLUMES[1]),
      managedVolume: volumes.some((volume) => volume.name === VOLUMES[2]),
      hostConfiguration,
    };
  }

  private archive(index: number) {
    return restoreDatabaseResources(this.options.job).prefix + '-previous-' + index;
  }

  private async validate(previous: RestorePreviousInstallation) {
    const { docker } = this.options;
    if (!docker.listContainers || !docker.renameContainer || !docker.setContainerRestartPolicy)
      throw new Error('Previous installation lifecycle unavailable');
    const current = await docker.listContainers();
    for (const [index, container] of previous.containers.entries()) {
      const found = current.find((candidate) => candidate.id === container.id);
      if (
        !found ||
        found.names?.length !== 1 ||
        ![container.name, this.archive(index)].includes(found.names[0]!)
      )
        throw new Error('Previous container checkpoint no longer matches');
    }
    return current;
  }

  async stop(previous: RestorePreviousInstallation, signal?: AbortSignal): Promise<void> {
    const { docker } = this.options;
    const current = await this.validate(previous);
    // Disable every reboot path first; a crash must not resurrect the old updater during trial.
    for (const container of previous.containers) {
      signal?.throwIfAborted();
      await docker.setContainerRestartPolicy!(container.id, { name: 'no', maximumRetryCount: 0 });
    }
    for (const [index, container] of previous.containers.entries()) {
      signal?.throwIfAborted();
      if ((await docker.inspectContainer(container.id)).running)
        await docker.stopContainer(container.id);
      if (
        !current
          .find((candidate) => candidate.id === container.id)!
          .names?.includes(this.archive(index))
      )
        await docker.renameContainer!(container.id, this.archive(index));
    }
  }

  /** Invoke only after canonical data and host configuration have been rolled back. */
  async resume(previous: RestorePreviousInstallation, signal?: AbortSignal): Promise<void> {
    const { docker } = this.options;
    const current = await this.validate(previous);
    for (const container of previous.containers) {
      if (
        current.some(
          (candidate) => candidate.id !== container.id && candidate.names?.includes(container.name),
        )
      )
        throw new Error('Previous container name is occupied; explicit cleanup required');
    }
    for (const container of previous.containers) {
      signal?.throwIfAborted();
      if (
        !current.find((candidate) => candidate.id === container.id)!.names?.includes(container.name)
      )
        await docker.renameContainer!(container.id, container.name);
      await docker.setContainerRestartPolicy!(container.id, {
        name: container.restartPolicy,
        maximumRetryCount: container.maximumRetryCount,
      });
      if (container.running && !(await docker.inspectContainer(container.id)).running)
        await docker.startContainer(container.id);
    }
  }
}
