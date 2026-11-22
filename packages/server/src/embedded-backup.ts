import { hostname } from 'node:os';
import { join } from 'node:path';
import type { DockerClient } from './docker.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { SERVER_COMPAT } from './self-update/compat.js';
import { openBackupRuntime, type BackupRuntimeOptions } from './backup/runtime.js';

export async function createEmbeddedBackup(ctx: {
  config: Pick<EmbeddedServerConfig, 'databaseUrl' | 'dataVolumeRoot'>;
  projectDocker: DockerClient | undefined;
  eventStore: BackupRuntimeOptions['store'];
}) {
  const { config, projectDocker, eventStore } = ctx;
  const backupArchitecture =
    process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined;
  return config.databaseUrl && config.dataVolumeRoot && projectDocker && backupArchitecture
    ? await openBackupRuntime({
        probe: {
          docker: projectDocker,
          network: 'verity-net',
          tufCachePath: join(config.dataVolumeRoot, 'backup-state', 'tuf-cache'),
        },
        root: config.dataVolumeRoot,
        databaseUrl: config.databaseUrl,
        currentImage: async () => (await projectDocker.inspectContainer(hostname())).image,
        architecture: backupArchitecture,
        release: SERVER_COMPAT.serverVersion,
        schema: SERVER_COMPAT.schema.current,
        store: eventStore,
        onError: () => {
          console.warn('verity: backup operation unavailable; queued revocations remain durable');
        },
      })
    : undefined;
}
