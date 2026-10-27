import { randomBytes } from 'node:crypto';
import type { DockerClient } from '../docker.js';

// PGDATA differs across PostgreSQL majors and may not exist before initdb.
// Its nearest existing parent is on the image's Docker-created data volume.
const CHECK_SPACE = `set -eu
path="$PGDATA"
case "$path" in /*) ;; *) exit 1 ;; esac
while [ ! -d "$path" ]; do path=$(dirname "$path"); done
available=$(df -Pk "$path" | awk 'NR == 2 { print $4 }')
case "$available" in ''|*[!0-9]*) exit 1 ;; esac
[ "$available" -ge "$1" ]`;

/** Check daemon-side PostgreSQL volume capacity, never the caller's staging filesystem. */
export async function checkProbeDatabaseSpace(options: {
  docker: Pick<
    DockerClient,
    'createContainer' | 'startContainer' | 'waitContainer' | 'removeContainer'
  >;
  image: string;
  architecture: 'amd64' | 'arm64';
  requiredBytes: bigint;
  signal?: AbortSignal;
  resourcePrefix?: string;
  timeoutMs?: number;
}): Promise<void> {
  const requiredKiB = (options.requiredBytes + 1023n) / 1024n;
  if (options.requiredBytes < 0n || requiredKiB > 9223372036854775807n)
    throw new Error('Invalid restore probe space requirement');
  if (!/^postgres:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}@sha256:[a-f0-9]{64}$/.test(options.image))
    throw new Error('Restore probe space check requires a pinned PostgreSQL image');
  const { docker } = options;
  if (!docker.waitContainer) throw new Error('Docker worker wait capability unavailable');
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new Error('Invalid restore probe space timeout');
  options.signal?.throwIfAborted();
  const worker = await docker.createContainer({
    name: options.resourcePrefix
      ? options.resourcePrefix + '-space'
      : 'verity-probe-space-' + randomBytes(16).toString('hex'),
    image: options.image,
    platform: `linux/${options.architecture}`,
    entrypoint: ['sh', '-c'],
    command: [CHECK_SPACE, 'verity-probe-space', requiredKiB.toString()],
    network: 'none',
    readOnlyRootfs: true,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    restartPolicy: 'no',
    pidsLimit: 16,
    cpuShares: 2,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Restore probe space check timed out')), timeoutMs);
      abort = () => reject(new Error('Restore probe space check aborted'));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    const completed = async () => {
      options.signal?.throwIfAborted();
      await docker.startContainer(worker.id);
      options.signal?.throwIfAborted();
      if ((await docker.waitContainer!(worker.id)) !== 0)
        throw new Error('Insufficient or unverifiable restore probe PostgreSQL space');
      options.signal?.throwIfAborted();
    };
    await Promise.race([completed(), stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
    await docker.removeContainer(worker.id);
  }
}
