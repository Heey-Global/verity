import { readManagedDeployment } from './managed-deployment.js';
import {
  archiveUpdateJournal,
  beginUpdate,
  readHighestGeneration,
  readUpdateJournal,
  withUpdateJournalLease,
  type UpdateJournal,
} from './update-journal.js';
import { isTerminalOperationState, projectUpdateOperation } from './update-operation.js';

export interface BridgeRecoveryAdmission {
  readonly root: string;
  readonly expectedDeploymentId: string;
  readonly expectedImage: string;
  readonly targetDigest: string;
  readonly idempotencyKey: string;
}

/**
 * Reserve a verified recovery request against the exact deployment inspected by
 * the host command. Older Updaters cannot compare an expected predecessor in their
 * two-field HTTP request, so checking it outside their journal lease would allow
 * a concurrent update to invalidate the compatibility decision before admission.
 *
 * The caller must verify the signed target and compatibility before calling this
 * privileged helper, then submit the same key and digest through the existing
 * Updater API to wake its executor. No deployment state is rewritten here.
 */
export async function admitBridgeRecovery(input: BridgeRecoveryAdmission): Promise<UpdateJournal> {
  const digest = /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/;
  const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
  if (
    !digest.test(input.expectedImage) ||
    !digest.test(input.targetDigest) ||
    !identifier.test(input.expectedDeploymentId) ||
    !identifier.test(input.idempotencyKey)
  )
    throw new Error('invalid bridge recovery admission');
  if (input.expectedImage === input.targetDigest) throw new Error('bridge is already current');

  return withUpdateJournalLease(input.root, async () => {
    const state = await readManagedDeployment(input.root);
    if (!state.managed) throw new Error('bridge recovery requires a managed deployment');
    if (
      state.marker.deploymentId !== input.expectedDeploymentId ||
      state.spec.image !== input.expectedImage
    )
      throw new Error('deployment changed since bridge recovery verification');

    const current = await readUpdateJournal(input.root);
    if (current !== null) {
      if (current.idempotencyKey === input.idempotencyKey) {
        if (
          current.deploymentId !== input.expectedDeploymentId ||
          current.previousDigest !== input.expectedImage ||
          current.targetDigest !== input.targetDigest
        )
          throw new Error('bridge recovery idempotency key belongs to a different request');
        return current;
      }
      if (!isTerminalOperationState(projectUpdateOperation(current).state)) {
        throw new Error('another update operation is in progress');
      }
      await archiveUpdateJournal(input.root);
    }
    return beginUpdate({
      root: input.root,
      deploymentId: input.expectedDeploymentId,
      idempotencyKey: input.idempotencyKey,
      currentGeneration: await readHighestGeneration(input.root),
      previousDigest: input.expectedImage,
      targetDigest: input.targetDigest,
    });
  });
}
