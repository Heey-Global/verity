import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { DockerClient } from './docker.js';
import type { LocalPreviewManager } from './local-preview-manager.js';
import type { ManagedDevServerManager } from './managed-dev-server-manager.js';
import type { UplinkControlClient } from './uplink-control-client.js';
import { sweepOrphanedLocalPreviews } from './local-preview-orphans.js';
import { sweepOrphanedPreviewShares, type PreviewShareManager } from './preview-share-manager.js';
import { startRunnerSupervisorReconciler } from './embedded-support.js';

type PreviewRecoveryContext = {
  secretCipher: { isSealed: () => boolean };
  projectDocker: DockerClient | undefined;
};

export async function installEmbeddedLocalPreviewRecovery(
  app: FastifyInstance,
  {
    localPreviewManager,
    projectDocker,
    secretCipher,
    managedDevServerManager,
    setPreviewRecoveryReady,
  }: PreviewRecoveryContext & {
    localPreviewManager:
      Pick<LocalPreviewManager, 'ownsConnector' | 'reconcile' | 'close'> | undefined;
    managedDevServerManager: Pick<ManagedDevServerManager, 'close'> | undefined;
    setPreviewRecoveryReady: (ready: boolean) => void;
  },
): Promise<void> {
  if (localPreviewManager && projectDocker) {
    const sweepLocalConnectors = () =>
      sweepOrphanedLocalPreviews(projectDocker, hostname(), (id, shareId) =>
        localPreviewManager.ownsConnector(id, shareId),
      );
    const reconcileLocal = async (): Promise<void> => {
      if (secretCipher.isSealed()) return;
      // Restore durable ownership before cleanup can classify surviving connectors.
      await localPreviewManager.reconcile();
      setPreviewRecoveryReady(true);
      await sweepLocalConnectors();
    };
    await reconcileLocal().catch((error) =>
      app.log.warn({ err: error }, 'local preview recovery deferred until dependencies recover'),
    );
    const stopLocalReconciler = startRunnerSupervisorReconciler(reconcileLocal, 10_000, (error) =>
      app.log.warn({ err: error }, 'local preview reconciliation failed'),
    );
    app.addHook('onClose', async () => {
      setPreviewRecoveryReady(false);
      await stopLocalReconciler();
      await managedDevServerManager?.close();
      await localPreviewManager.close();
    });
  }
}

export async function installEmbeddedPublicPreviewRecovery(
  app: FastifyInstance,
  {
    previewShareManager,
    projectDocker,
    secretCipher,
    uplinkControl,
    eventStore,
    managedLinkEnded,
  }: PreviewRecoveryContext & {
    previewShareManager: Pick<PreviewShareManager, 'reconcile'> | undefined;
    uplinkControl: Pick<UplinkControlClient, 'stop'> | undefined;
    eventStore: Parameters<typeof sweepOrphanedPreviewShares>[0]['store'];
    managedLinkEnded: { current?: (instanceId: string, shareId: string) => void };
  },
): Promise<void> {
  if (previewShareManager !== undefined) {
    const reconcile = async (): Promise<void> => {
      if (secretCipher.isSealed()) return;
      await previewShareManager.reconcile();
    };
    await reconcile().catch((error) =>
      app.log.warn({ err: error }, 'public preview reconciliation failed'),
    );
    const stopPreviewReconciler = startRunnerSupervisorReconciler(reconcile, 30_000, (error) =>
      app.log.warn({ err: error }, 'public preview reconciliation failed'),
    );
    app.addHook('onClose', async () => {
      await stopPreviewReconciler();
      await uplinkControl?.stop();
    });
  } else if (projectDocker !== undefined) {
    // No edge control means no manager and therefore no reconciliation loop, so
    // shares an earlier version created would run on untouched. Close them out
    // instead of leaving live connectors and unrevocable records behind. This
    // retries on the reconcile cadence rather than only at boot — a Docker or
    // store hiccup during startup must not strand a share for the process
    // lifetime — and stops the timer once a sweep completes cleanly, because
    // without a manager nothing can create new shares to find.
    let sweeping = false;
    const sweep = async (): Promise<void> => {
      if (sweeping) return;
      sweeping = true;
      try {
        const swept = await sweepOrphanedPreviewShares({
          store: eventStore,
          docker: projectDocker,
          onShareEnded: ({ managedInstanceId, id }) => {
            if (managedInstanceId) managedLinkEnded.current?.(managedInstanceId, id);
          },
        });
        if (swept > 0) {
          app.log.warn({ swept }, 'revoked orphaned public preview shares');
        }
        clearInterval(sweepTimer);
      } catch (error) {
        app.log.warn({ err: error }, 'orphaned public preview sweep failed, retrying');
      } finally {
        sweeping = false;
      }
    };
    const sweepTimer = setInterval(() => void sweep(), 30_000);
    sweepTimer.unref?.();
    app.addHook('onClose', () => clearInterval(sweepTimer));
    void sweep();
  }
}
