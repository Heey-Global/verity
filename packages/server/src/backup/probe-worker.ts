import { randomBytes } from 'node:crypto';
import type { DockerClient } from '../docker.js';
import type { BackupManifest } from './format.js';
import { captureMetadataSchema } from './capture-metadata.js';

/** Run only migrations from the authenticated snapshot image, without live mounts or server startup. */
export async function runPinnedProbeMigration(options: {
  docker: Pick<
    DockerClient,
    'createContainer' | 'startContainer' | 'waitContainer' | 'removeContainer'
  >;
  manifest: BackupManifest;
  architecture: 'amd64' | 'arm64';
  databaseUrl: string;
  network: string;
  signal?: AbortSignal;
  resourcePrefix?: string;
  resourceLabels?: Record<string, string>;
  timeoutMs?: number;
}): Promise<void> {
  const { docker, manifest } = options;
  const capture = captureMetadataSchema.parse(manifest.capture);
  if (capture.architecture !== options.architecture || typeof manifest.schema !== 'string')
    throw new Error('Restore probe requires a native image and named schema');
  if (!docker.waitContainer) throw new Error('Docker worker wait capability unavailable');
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new Error('Invalid restore probe migration timeout');
  options.signal?.throwIfAborted();
  const worker = await docker.createContainer({
    image: capture.image,
    platform: `linux/${options.architecture}`,
    name: options.resourcePrefix
      ? options.resourcePrefix + '-migrate'
      : 'verity-probe-migrate-' + randomBytes(16).toString('hex'),
    command: ['backup-probe-migrate'],
    ...(options.resourceLabels ? { labels: options.resourceLabels } : {}),
    network: options.network,
    env: [
      `VERITY_BACKUP_PROBE_DATABASE_URL=${options.databaseUrl}`,
      `VERITY_BACKUP_PROBE_SCHEMA=${manifest.schema}`,
    ],
    readOnlyRootfs: true,
    tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m' },
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    restartPolicy: 'no',
    pidsLimit: 64,
    cpuShares: 2,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Restore probe migration timed out')), timeoutMs);
      abort = () => reject(new Error('Restore probe migration aborted'));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    const completed = async () => {
      options.signal?.throwIfAborted();
      await docker.startContainer(worker.id);
      const code = await docker.waitContainer!(worker.id);
      if (code !== 0) throw new Error('Pinned restore probe migration failed');
    };
    await Promise.race([completed(), stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
    await docker.removeContainer(worker.id);
  }
}
