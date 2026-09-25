import { lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_SEED_MOUNT_PATH } from './self-update/agent-seed-stamp.js';
import { createDockerClient } from './docker.js';
import { recoverManagedUpdater } from './self-update/update-runner.js';
import {
  enableManagedMatrixConnector,
  reconcileManagedMatrixConnector,
} from './self-update/managed-matrix-connector.js';
import { createStandbyExchange } from './self-update/standby-directive.js';
import { startUpdaterStatusServer } from './self-update/updater-status.js';
import { readControlPlanePostgresState } from './self-update/postgres-image.js';
import {
  MANAGED_DEPLOYMENT_ROOT,
  readManagedDeployment,
  type ManagedDeploymentState,
} from './self-update/managed-deployment.js';

/**
 * The group allowed to use the Updater's control socket.
 *
 * Derived from the sealed spec rather than from the environment: the same
 * document that decides the Server runs as this gid also decides whether the
 * control volume reaches it. A deployment sealed before the mount existed keeps
 * an owner-only socket, which is exactly right — its Server has no path to the
 * volume, so publishing a token there would widen the boundary for nobody.
 */
function updaterPeerGid(state: ManagedDeploymentState): number | undefined {
  if (!state.managed) return undefined;
  const mounted = state.spec.mounts.some(
    (mount) => mount.source.kind === 'volume' && mount.source.name === 'verity-updater-control',
  );
  return mounted ? state.spec.user.gid : undefined;
}

export async function startManagedUpdaterMain(): Promise<void> {
  const tokenFile = process.env.VERITY_UPDATER_TOKEN_FILE;
  if (tokenFile === undefined || !tokenFile.startsWith('/run/secrets/')) {
    throw new Error('VERITY_UPDATER_TOKEN_FILE must name a /run/secrets file');
  }
  const tokenInfo = await lstat(tokenFile);
  if (
    !tokenInfo.isFile() ||
    tokenInfo.isSymbolicLink() ||
    tokenInfo.uid !== process.geteuid?.() ||
    (tokenInfo.mode & 0o077) !== 0
  ) {
    throw new Error('Updater control token file must be a private regular file');
  }
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
  // An Updater that died mid-update left durable intent behind, and the
  // journal is the only thing that knows how far it got. Finish that, then
  // reconcile — both before the boundary opens, so a restart continues the
  // operation instead of stranding it, and so the single slot is free again
  // by the time a device retries.
  // Shared between the control boundary, which publishes the directive and
  // collects what the outgoing Server reports, and the cutover, which asks and
  // then waits for it before promoting a candidate (ADR 0008 D9). Created here
  // because it is the one thing both halves of this process look at.
  const standby = createStandbyExchange();
  const runner = await recoverManagedUpdater({
    managedRoot: MANAGED_DEPLOYMENT_ROOT,
    docker,
    cutover: { standby },
  });
  const peerGid = updaterPeerGid(await readManagedDeployment(MANAGED_DEPLOYMENT_ROOT));
  let matrixReconcilePending = false;
  let matrixReconcileRequested = false;
  let matrixRetry: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const scheduleMatrixReconcile = (): void => {
    if (stopping) return;
    if (matrixReconcilePending) {
      matrixReconcileRequested = true;
      return;
    }
    matrixReconcilePending = true;
    void runner
      .enqueueExclusive(() =>
        reconcileManagedMatrixConnector({ managedRoot: MANAGED_DEPLOYMENT_ROOT, docker }),
      )
      .catch((error: unknown) => {
        console.error('managed Matrix connector reconciliation failed', error);
        if (!stopping) {
          matrixRetry = setTimeout(() => {
            matrixRetry = undefined;
            scheduleMatrixReconcile();
          }, 10_000);
          matrixRetry.unref?.();
        }
      })
      .finally(() => {
        matrixReconcilePending = false;
        if (matrixReconcileRequested) {
          matrixReconcileRequested = false;
          if (matrixRetry !== undefined) clearTimeout(matrixRetry);
          matrixRetry = undefined;
          scheduleMatrixReconcile();
        }
      });
  };
  // Passed only when the read-only seed mount is really there. A deployment
  // whose compose file predates that mount has to report "not visible", which
  // is a different fact from "mounted, and the seed carries no stamp" — the
  // first says nothing about the sandboxes, the second says they are running
  // wrappers of unknown provenance.
  const managedSeedPath = join(AGENT_SEED_MOUNT_PATH, '.current');
  const agentSeedPath = await stat(managedSeedPath).then(
    (info) => (info.isDirectory() ? managedSeedPath : undefined),
    () => undefined,
  );
  const updater = await startUpdaterStatusServer({
    socketPath: '/run/verity-updater/control/updater.sock',
    token,
    managedRoot: MANAGED_DEPLOYMENT_ROOT,
    standby,
    // What the reconcile above concluded. An Updater that tolerated a running
    // Server on a drifted environment has to be able to say so, or the
    // tolerance is indistinguishable from not having looked.
    reconcile: runner.reconcile,
    // Read fresh on every request rather than captured once: the digest this
    // answers for changes underneath the boundary — a cutover swaps it — and a
    // value taken at startup would keep reporting the state that existed
    // before the update that fixed it (ADR 0008 D14).
    postgres: async () => {
      const state = await readManagedDeployment(MANAGED_DEPLOYMENT_ROOT);
      if (!state.managed) throw new Error(state.reason);
      return readControlPlanePostgresState({
        docker,
        serverImage: state.spec.image,
        network: state.spec.network,
      });
    },
    ...(agentSeedPath === undefined ? {} : { agentSeedPath }),
    ...(peerGid === undefined ? {} : { peerGid }),
    onOperationAccepted: () => {
      runner.start();
    },
    onMatrixConfigured: async () => {
      await enableManagedMatrixConnector(MANAGED_DEPLOYMENT_ROOT);
      if (matrixRetry !== undefined) {
        clearTimeout(matrixRetry);
        matrixRetry = undefined;
      }
      scheduleMatrixReconcile();
    },
  });
  // Connector failures must not keep the update control socket offline.
  scheduleMatrixReconcile();
  const stop = async (): Promise<void> => {
    stopping = true;
    if (matrixRetry !== undefined) clearTimeout(matrixRetry);
    await updater.close();
    // Every step is journalled before it runs, so being killed here is safe —
    // but finishing the current one avoids an avoidable resume.
    await runner.idle();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  return;
}
