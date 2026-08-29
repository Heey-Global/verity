import {
  advanceUpdate,
  failUpdate,
  readUpdateJournal,
  withUpdateJournalLease,
  type UpdateJournal,
} from './update-journal.js';

export interface StandbyCandidate {
  readonly containerId: string;
  readonly containerName: string;
}

export interface UpdatePreparationDeps {
  /** Idempotently ensure the exact digest exists locally. */
  readonly pullImage: (digest: string) => Promise<void>;
  /** Independently verify official signature/provenance and image metadata. */
  readonly verifyImage: (journal: UpdateJournal) => Promise<void>;
  /** Execute the target image's distinct, read-only preflight entrypoint. */
  readonly runPreflight: (journal: UpdateJournal) => Promise<void>;
  /** Upgrade durable authority only after preflight has proved the candidate. */
  readonly prepareStandby?: (journal: UpdateJournal) => Promise<void>;
  /** Idempotently create or inspect the operation-bound, non-routed standby. */
  readonly ensureStandby: (journal: UpdateJournal) => Promise<StandbyCandidate>;
  readonly now?: () => Date;
}

function isActivePhase(
  phase: UpdateJournal['phase'],
): phase is 'requested' | 'pulling' | 'verifying-image' | 'preflight' {
  return ['requested', 'pulling', 'verifying-image', 'preflight'].includes(phase);
}

/**
 * Resume preparation from the durable intent phase. Each external action is
 * preceded by its journal transition; a SIGKILL therefore reruns at most one
 * idempotent action and can never skip verification or preflight.
 */
export async function resumeUpdatePreparation(
  root: string,
  deps: UpdatePreparationDeps,
): Promise<UpdateJournal> {
  return withUpdateJournalLease(root, async () => resumeLeased(root, deps));
}

async function resumeLeased(root: string, deps: UpdatePreparationDeps): Promise<UpdateJournal> {
  let journal = await readUpdateJournal(root);
  if (journal === null) throw new Error('update journal does not exist');
  if (journal.phase === 'failed' || journal.phase === 'standby') return journal;
  const timing = deps.now === undefined ? {} : { now: deps.now };
  try {
    if (journal.phase === 'requested') {
      journal = await advanceUpdate(root, 'requested', 'pulling', timing);
    }
    if (journal.phase === 'pulling') {
      await deps.pullImage(journal.targetDigest);
      journal = await advanceUpdate(root, 'pulling', 'verifying-image', timing);
    }
    if (journal.phase === 'verifying-image') {
      await deps.verifyImage(journal);
      journal = await advanceUpdate(root, 'verifying-image', 'preflight', timing);
    }
    if (journal.phase === 'preflight') {
      await deps.runPreflight(journal);
      journal = await advanceUpdate(root, 'preflight', 'creating-standby', timing);
    }
    if (journal.phase === 'creating-standby') {
      await deps.prepareStandby?.(journal);
      const candidate = await deps.ensureStandby(journal);
      journal = await advanceUpdate(root, 'creating-standby', 'standby', {
        ...timing,
        candidate,
      });
    }
    return journal;
  } catch (error) {
    const current = await readUpdateJournal(root);
    if (current !== null && current.phase === journal.phase && isActivePhase(journal.phase)) {
      if (deps.now === undefined) await failUpdate(root, journal.phase, `${journal.phase}-failed`);
      else await failUpdate(root, journal.phase, `${journal.phase}-failed`, deps.now);
    }
    throw error;
  }
}
