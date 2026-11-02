import { join } from 'node:path';
import type { DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import { readBounded } from './repository.js';

const LOAD = `set -eu
from=/from
to=/to
for scope in workspaces sessions knowledge; do
  if [ ! -d "$from/$scope" ] || [ -L "$from/$scope" ]; then exit 1; fi
done
required=$(du -skx "$from/workspaces" "$from/sessions" "$from/knowledge" | awk '{sum += $1} END {printf "%.0f\\n", sum}')
available=$(df -Pk "$to" | awk 'NR == 2 {print $4}')
for number in "$required" "$available"; do
  case "$number" in ''|*[!0-9]*) exit 1 ;; esac
done
[ "$available" -ge "$((required + 65536))" ]
find "$to" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
for scope in workspaces sessions knowledge; do
  if [ ! -d "$from/$scope" ] || [ -L "$from/$scope" ]; then exit 1; fi
  cp -a "$from/$scope" "$to/"
done
cp "$from/.verity-recovery-pending" "$to/.verity-recovery-pending"
chown -hR "$1:$2" "$to"
sync -f "$to"`;

/** Populate a job-owned data volume. Snapshot DB exports and host identity never enter live data. */
export function createRestoreDataVolume(options: {
  docker: DockerClient;
  uid?: number;
  gid?: number;
}): (job: RestoreJob, tree: string, signal?: AbortSignal) => Promise<void> {
  const uid = options.uid ?? 1000;
  const gid = options.gid ?? 1000;
  if (![uid, gid].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Invalid restore data owner');
  return async (job, tree, signal) => {
    const { docker } = options;
    if (
      !job.verified ||
      !docker.ensureVolume ||
      !docker.listVolumes ||
      !docker.listContainers ||
      !docker.removeVolume ||
      !docker.waitContainer
    )
      throw new Error('Restore data volume capabilities unavailable');
    const resources = restoreDatabaseResources(job);
    const name = resources.prefix + '-load';
    const volumeName = resources.prefix + '-data';
    if ((await readBounded(join(tree, '.verity-recovery-pending'), 128)).toString() !== job.id)
      throw new Error('Restore data staging ownership mismatch');
    const previous = (await docker.listContainers()).filter((container) =>
      container.names?.includes(name),
    );
    const volume = (await docker.listVolumes()).find((volume) => volume.name === volumeName);
    if (
      previous.some((container) => container.labels?.['verity.restore-job'] !== job.id) ||
      (volume && volume.labels['verity.restore-job'] !== job.id)
    )
      throw new Error('Restore data resource ownership mismatch');
    signal?.throwIfAborted();
    for (const container of previous) await docker.removeContainer(container.id);
    if (volume) await docker.removeVolume(volume.name);
    await docker.ensureVolume(volumeName, { labels: resources.labels });
    if (
      (await docker.listVolumes()).find((volume) => volume.name === volumeName)?.labels[
        'verity.restore-job'
      ] !== job.id
    )
      throw new Error('Restore data volume ownership mismatch');
    signal?.throwIfAborted();
    const worker = await docker.createContainer({
      image: job.verified.image,
      name,
      labels: resources.labels,
      platform: `linux/${job.verified.architecture}`,
      entrypoint: ['sh', '-c'],
      command: [LOAD, 'verity-restore-load', String(uid), String(gid)],
      binds: [`${tree}:/from:ro`],
      volumeMounts: [{ volume: volumeName, target: '/to' }],
      user: '0:0',
      network: 'none',
      readOnlyRootfs: true,
      securityOpt: ['no-new-privileges:true'],
      restartPolicy: 'no',
      pidsLimit: 64,
      cpuShares: 2,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Restore data load timed out')), 60 * 60 * 1000);
        abort = () => reject(new Error('Restore data load aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      await Promise.race([
        (async () => {
          signal?.throwIfAborted();
          await docker.startContainer(worker.id);
          if ((await docker.waitContainer!(worker.id)) !== 0)
            throw new Error('Restore data load failed');
          signal?.throwIfAborted();
        })(),
        stopped,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      await docker.removeContainer(worker.id);
    }
  };
}
