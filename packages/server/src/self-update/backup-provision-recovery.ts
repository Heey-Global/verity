import { backupProvisionPlan, provisionBackupHost } from './backup-provisioning.js';
import type { UpdatePreparationDocker } from './docker-update-preparation.js';
import { readManagedDeployment } from './managed-deployment.js';
import { readUpdateJournal, withUpdateJournalLease } from './update-journal.js';
import { createOfficialImageVerifier } from './update-runner.js';

export interface BackupProvisionRecoverySnapshot {
  readonly updateId: string;
  readonly generation: number;
  readonly targetDigest: string;
  readonly journalChecksum: string;
  readonly deploymentChecksum: string;
}

/** An explicit local repair of host prerequisites, never a replacement update.
 * The original Updater cannot acquire this lease while the helper is working.
 * Its journal, candidate, sealed mounts and target digest are never changed.
 */
export async function recoverBackupProvisioning(options: {
  managedRoot: string;
  docker: UpdatePreparationDocker;
  expected?: BackupProvisionRecoverySnapshot;
}): Promise<BackupProvisionRecoverySnapshot & { provisioned: boolean }> {
  return withUpdateJournalLease(options.managedRoot, async () => {
    const state = await readManagedDeployment(options.managedRoot);
    const journal = await readUpdateJournal(options.managedRoot);
    if (
      !state.managed ||
      !journal ||
      journal.phase !== 'creating-standby' ||
      journal.candidate !== null ||
      journal.deploymentId !== state.spec.deploymentId ||
      journal.previousDigest !== state.spec.image
    )
      throw new Error('Backup repair requires an unchanged pre-cutover standby preparation');
    const snapshot: BackupProvisionRecoverySnapshot = {
      updateId: journal.updateId,
      generation: journal.generation,
      targetDigest: journal.targetDigest,
      journalChecksum: journal.checksum,
      deploymentChecksum: state.spec.checksum,
    };
    if (
      options.expected &&
      (Object.keys(snapshot) as (keyof BackupProvisionRecoverySnapshot)[]).some(
        (key) => snapshot[key] !== options.expected![key],
      )
    )
      throw new Error('Update changed since the backup repair was checked; check again');
    await createOfficialImageVerifier(options.docker)(journal);
    const plan = await backupProvisionPlan(options.docker, state.spec, journal.targetDigest);
    if (!plan) throw new Error('This update has no release-owned backup provisioning capability');
    if (options.expected && !plan.provisioned)
      await provisionBackupHost(options.docker, state.spec, journal.targetDigest, plan);
    return { ...snapshot, provisioned: options.expected !== undefined || plan.provisioned };
  });
}
