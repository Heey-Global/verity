import { BACKUP_PROVISION_LABEL, backupProvisionPlan } from './backup-provisioning.js';
import type { UpdatePreparationDocker } from './docker-update-preparation.js';
import { readManagedDeployment } from './managed-deployment.js';
import { createOfficialImageVerifier } from './update-runner.js';
import {
  archiveUpdateJournal,
  beginUpdate,
  readHighestGeneration,
  readUpdateJournal,
  withUpdateJournalLease,
} from './update-journal.js';

/** Old Updaters cannot execute a preparation hook they do not yet contain.
 * The successor queues one ordinary guarded replacement of the same release.
 * The previous successful operation is archived, never rewritten as this repair.
 */
export async function scheduleLegacyBackupUpgrade(options: {
  managedRoot: string;
  docker: UpdatePreparationDocker;
}): Promise<boolean> {
  return withUpdateJournalLease(options.managedRoot, async () => {
    const state = await readManagedDeployment(options.managedRoot);
    if (!state.managed) return false;
    const image = state.spec.image;
    const journal = await readUpdateJournal(options.managedRoot);
    // Never compete with a live operation, retry a terminal failure on boot,
    // or undo a deliberate rollback. A new explicit update may retry preparation.
    if (journal && journal.phase !== 'completed') return false;
    const key = `backup-provision-v1:${image.split('@')[1] ?? ''}`;
    if (journal?.idempotencyKey === key) return false;
    await createOfficialImageVerifier(options.docker)({ targetDigest: image });
    if ((await options.docker.inspectImageLabels?.(image))?.[BACKUP_PROVISION_LABEL] !== '1')
      return false;
    if (!state.spec.mounts.some((mount) => mount.target === '/run/verity-pairing')) return false;
    const mounted =
      state.spec.mounts.some((mount) => mount.target === '/run/verity-backups') &&
      state.spec.mounts.some((mount) => mount.target === '/run/verity-backup-identity');
    if (mounted) {
      // Unsafe/unreadable host state must fail inside the visible update journal,
      // rather than disappearing as a startup-only error with no retry surface.
      const plan = await backupProvisionPlan(options.docker, state.spec, image).catch(
        () => undefined,
      );
      if (plan?.provisioned) return false;
    }
    const generation = await readHighestGeneration(options.managedRoot);
    if (journal) await archiveUpdateJournal(options.managedRoot);
    await beginUpdate({
      root: options.managedRoot,
      deploymentId: state.spec.deploymentId,
      idempotencyKey: key,
      currentGeneration: generation,
      previousDigest: image,
      targetDigest: image,
    });
    return true;
  });
}
