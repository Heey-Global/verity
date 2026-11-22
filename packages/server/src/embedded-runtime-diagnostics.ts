import { hostname } from 'node:os';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { BuildStorage } from './build-storage.js';
import type { DependencyCapacity } from './dependency-capacity.js';
import type { ProvisionerImpl } from './provisioner.js';
import type { DataVolumeUsage } from './data-volume-usage.js';
import type { SessionStorage } from './session-storage.js';
import type { RunnerCacheStorage } from './runner-cache-storage.js';
import { createRuntimeDiagnostics } from './runtime-diagnostics.js';
import { databaseStorageBytes } from './embedded-build-storage.js';
import { readNativeReclamation } from './storage-reclamation.js';
import { sessionStorageDiagnostics } from './session-storage.js';
import { dockerGcDiagnostics, type DockerGcReport } from './docker-gc.js';

export function createEmbeddedRuntimeDiagnostics(ctx: {
  config: Pick<
    EmbeddedServerConfig,
    | 'dockerBaseUrl'
    | 'dataVolumeRoot'
    | 'diagnosticServerContainerId'
    | 'hostDiagnosticSnapshotPath'
  >;
  db: Parameters<typeof databaseStorageBytes>[0];
  buildStorage: Pick<BuildStorage, 'unresolvedAttempts' | 'queueState'> | undefined;
  dependencyCapacity: Pick<DependencyCapacity, 'diagnostics'> | undefined;
  sessionStorage: Pick<SessionStorage, 'lastReport'> | undefined;
  runnerCacheStorage: Pick<RunnerCacheStorage, 'lastReport'> | undefined;
  volumeUsage: Pick<DataVolumeUsage, 'diagnostics'> | undefined;
  provisioner: Pick<ProvisionerImpl, 'lastBuildFailure'> | undefined;
  getLastDockerGcReport: () => DockerGcReport | undefined;
}) {
  const {
    config,
    db,
    buildStorage,
    dependencyCapacity,
    sessionStorage,
    runnerCacheStorage,
    volumeUsage,
    provisioner,
    getLastDockerGcReport,
  } = ctx;
  return createRuntimeDiagnostics({
    dockerBaseUrl: config.dockerBaseUrl,
    dataRoot: config.dataVolumeRoot,
    serverContainerId: config.diagnosticServerContainerId?.trim() || hostname(),
    hostSnapshotPath: config.hostDiagnosticSnapshotPath,
    builderMigrationPath: '/run/verity-buildkit/migration-status.json',
    builderAdmissionDirectory: '/run/verity-buildkit',
    buildStorageReportPath: '/run/verity-host-diagnostics/storage.json',
    buildStorageReservations: () => buildStorage?.unresolvedAttempts() ?? [],
    buildQueue: () => buildStorage?.queueState() ?? { waiting: 0 },
    dependencyCapacity: () => dependencyCapacity?.diagnostics(),
    storageReclamation: async () => {
      const report = sessionStorage?.lastReport;
      const databaseBytes = await databaseStorageBytes(db);
      const nativeBuildkit = await readNativeReclamation();
      const lastDockerGcReport = getLastDockerGcReport();
      return {
        accounting:
          'Image and dependency sizes are estimates with shared layers/reflinks; do not sum categories. Unknown measurements are null. No freed-byte claim is inferred from apparent sizes.',
        lastGc: lastDockerGcReport ? dockerGcDiagnostics(lastDockerGcReport) : null,
        dataVolume: volumeUsage?.diagnostics() ?? null,
        worktrees: report ? sessionStorageDiagnostics(report) : null,
        runnerCaches: runnerCacheStorage?.lastReport ?? null,
        databaseBytes,
        nativeBuildkit,
        activeBuildkitBytes:
          typeof nativeBuildkit?.overlayAllocatedBytes === 'number'
            ? nativeBuildkit.overlayAllocatedBytes
            : null,
      };
    },
    projectBuildFailure: (projectId) => provisioner?.lastBuildFailure(projectId),
  });
}
