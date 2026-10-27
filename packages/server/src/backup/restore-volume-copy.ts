import type { DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';

// The destination is disposable staging or a checkpointed canonical volume. Never dereference links.
const COPY = `set -eu
required=$(du -skx /from | awk '{print $1}')
reclaimable=$(du -skx /to | awk '{print $1}')
available=$(df -Pk /to | awk 'NR == 2 {print $4}')
for number in "$required" "$reclaimable" "$available"; do
  case "$number" in ''|*[!0-9]*) exit 1 ;; esac
done
[ "$((available + reclaimable))" -ge "$((required + 65536))" ]
find /to -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a /from/. /to/
sync -f /to`;

/** Cold copies retain ownership, symlinks and Git metadata. Call only while every writer is stopped. */
export async function copyRestoreVolume(options: {
  docker: DockerClient;
  job: RestoreJob;
  source: string;
  destination: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { docker, job, signal } = options;
  if (!job.verified || !docker.waitContainer || !docker.listContainers || !docker.listVolumes)
    throw new Error('Verified restore and Docker ownership inspection required');
  const resources = restoreDatabaseResources(job);
  const allowed = new Set([
    `verity-data:${resources.prefix}-previous-data`,
    `verity-db:${resources.prefix}-previous-db`,
    `verity-managed-deployment:${resources.prefix}-previous-managed`,
    `${resources.prefix}-data:verity-data`,
    `${resources.volume}:verity-db`,
    `${resources.prefix}-managed:verity-managed-deployment`,
    `${resources.prefix}-previous-data:verity-data`,
    `${resources.prefix}-previous-db:verity-db`,
    `${resources.prefix}-previous-managed:verity-managed-deployment`,
  ]);
  if (!allowed.has(`${options.source}:${options.destination}`))
    throw new Error('Invalid restore volume copy');
  const volumes = await docker.listVolumes();
  for (const name of [options.source, options.destination]) {
    const volume = volumes.find((volume) => volume.name === name);
    if (
      !volume ||
      (name.startsWith(resources.prefix) && volume.labels['verity.restore-job'] !== job.id)
    )
      throw new Error('Restore copy volume missing or ownership mismatch');
  }
  const name = resources.prefix + '-copy';
  const previous = (await docker.listContainers()).filter((container) =>
    container.names?.includes(name),
  );
  if (previous.some((container) => container.labels?.['verity.restore-job'] !== job.id))
    throw new Error('Restore copy worker ownership mismatch');
  signal?.throwIfAborted();
  for (const container of previous) await docker.removeContainer(container.id);
  const worker = await docker.createContainer({
    image: job.verified.image,
    name,
    labels: resources.labels,
    platform: `linux/${job.verified.architecture}`,
    entrypoint: ['sh', '-c'],
    command: [COPY],
    user: '0:0',
    network: 'none',
    volumeMounts: [
      { volume: options.source, target: '/from', readOnly: true },
      { volume: options.destination, target: '/to' },
    ],
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
      timer = setTimeout(() => reject(new Error('Restore volume copy timed out')), 60 * 60 * 1000);
      abort = () => reject(new Error('Restore volume copy aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    await Promise.race([
      (async () => {
        signal?.throwIfAborted();
        await docker.startContainer(worker.id);
        if ((await docker.waitContainer!(worker.id)) !== 0)
          throw new Error('Restore volume copy failed');
        signal?.throwIfAborted();
      })(),
      stopped,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    await docker.removeContainer(worker.id);
  }
}
