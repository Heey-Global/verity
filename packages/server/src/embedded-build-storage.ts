import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { BuildStorage } from './build-storage.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { startNativeRetirementEvidence } from './native-buildkit.js';
import { dockerHostFor } from './project-backend.js';
import { createProtectedBuildClient } from './project-egress-build-client.js';
import { devcontainerBuilderIdle, type ProvisionerImpl } from './provisioner.js';

export function createEmbeddedBuildStorage(
  config: Pick<EmbeddedServerConfig, 'dataVolumeRoot' | 'dataDir' | 'workspacesDir'>,
): { buildStorage: BuildStorage; stopNativeEvidence: () => void } {
  const buildStorage = new BuildStorage(
    join(
      config.dataVolumeRoot ?? config.dataDir ?? config.workspacesDir ?? join(tmpdir(), 'verity'),
      'build-storage',
    ),
    undefined,
    undefined,
    undefined,
    '/run/verity-buildkit',
  );
  const retirementEvidence = startNativeRetirementEvidence(
    () => buildStorage.retirementInventoryEmpty() === true,
  );
  return { buildStorage, stopNativeEvidence: () => retirementEvidence.stop() };
}

export function installEmbeddedBuildStorage(
  app: FastifyInstance,
  {
    config,
    buildStorage,
    provisioner,
  }: {
    config: Pick<
      EmbeddedServerConfig,
      'dockerBaseUrl' | 'projectEgressSocketPath' | 'projectEgressKeyPath'
    >;
    buildStorage: Pick<BuildStorage, 'setReleaseListener' | 'reconcile'> | undefined;
    provisioner: Pick<ProvisionerImpl, 'resetStorageRefusedRepairBackoff'> | undefined;
  },
): void {
  // An interrupted build must not hold build storage until someone reboots the host.
  // Ask at start and every five minutes whether earlier attempts provably ended.
  if (buildStorage !== undefined) {
    const storage = buildStorage;
    // A recreate refused for build storage waits out its backoff otherwise; the
    // space it waited for is free now, so let the next reconcile pass retry it.
    storage.setReleaseListener(() => provisioner?.resetStorageRefusedRepairBackoff?.());
    const buildDockerHost =
      config.dockerBaseUrl === undefined ? undefined : dockerHostFor(config.dockerBaseUrl);
    let reconciling = false;
    const reconcileBuildStorage = async () => {
      if (reconciling) return;
      reconciling = true;
      try {
        const unresolved = await storage.reconcile({
          ...(buildDockerHost === undefined
            ? {}
            : { buildkitIdle: () => devcontainerBuilderIdle(buildDockerHost) }),
          ...(config.projectEgressSocketPath && config.projectEgressKeyPath
            ? {
                protectedBuildStatus: (reference: { projectId: string; attemptId: string }) =>
                  createProtectedBuildClient({
                    socketPath: config.projectEgressSocketPath!,
                    token: () => readFileSync(config.projectEgressKeyPath!, 'utf8').trim(),
                  })({ operation: 'status', ...reference }),
                protectedBuildSlot: () =>
                  createProtectedBuildClient({
                    socketPath: config.projectEgressSocketPath!,
                    token: () => readFileSync(config.projectEgressKeyPath!, 'utf8').trim(),
                  })({ operation: 'slot' }),
              }
            : {}),
        });
        if (unresolved.length > 0)
          app.log.warn(
            { attempts: unresolved },
            'Build storage holds space for earlier build attempts whose end is not yet confirmed',
          );
      } catch (err) {
        app.log.warn({ err }, 'Build storage reconciliation failed');
      } finally {
        reconciling = false;
      }
    };
    void reconcileBuildStorage();
    const buildStorageTimer = setInterval(() => void reconcileBuildStorage(), 5 * 60_000);
    buildStorageTimer.unref();
    app.addHook('onClose', () => clearInterval(buildStorageTimer));
  }
}
