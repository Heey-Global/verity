import {
  advanceCutover,
  readUpdateJournal,
  withUpdateJournalLease,
  type CutoverPhase,
  type UpdateJournal,
} from './update-journal.js';

export type { CutoverPhase } from './update-journal.js';

export interface CutoverState {
  readonly operationId: string;
  readonly phase: CutoverPhase;
  readonly oldGeneration: number;
  readonly candidateGeneration: number;
  readonly oldContainerId: string;
  readonly candidateContainerId: string;
}

export interface CutoverStateStore {
  /** Hold the crash-released single-writer lease for the complete orchestration run. */
  readonly runExclusive: <T>(run: () => Promise<T>) => Promise<T>;
  readonly read: () => Promise<CutoverState>;
  /** Persist the next intent with compare-and-swap semantics before external work. */
  readonly transition: (expected: CutoverPhase, next: CutoverPhase) => Promise<CutoverState>;
}

function journalState(journal: UpdateJournal, previousContainerId: string): CutoverState {
  if (journal.candidate === null) throw new Error('cutover journal has no candidate');
  if (
    journal.phase === 'failed' ||
    (!ROLLBACK_PHASES.has(journal.phase as CutoverPhase) &&
      ![
        'standby',
        'quiescing-old',
        'handing-off-key',
        'activating-candidate',
        'checking-candidate',
        'draining-gateway',
        'switching-gateway',
        'observing-candidate',
        'committed',
      ].includes(journal.phase))
  )
    throw new Error(`update journal is not in a cutover phase: ${journal.phase}`);
  return {
    operationId: journal.updateId,
    phase: journal.phase as CutoverPhase,
    oldGeneration: journal.generation - 1,
    candidateGeneration: journal.generation,
    oldContainerId: journal.previousContainerId ?? previousContainerId,
    candidateContainerId: journal.candidate.containerId,
  };
}

export function createUpdateJournalCutoverStore(
  root: string,
  previousContainerId: string,
): CutoverStateStore {
  return {
    runExclusive: (run) => withUpdateJournalLease(root, run),
    read: async () => {
      const journal = await readUpdateJournal(root);
      if (journal === null) throw new Error('update journal does not exist');
      return journalState(journal, previousContainerId);
    },
    transition: async (expected, next) =>
      journalState(
        await advanceCutover(root, expected, next, { previousContainerId }),
        previousContainerId,
      ),
  };
}

export interface UpdateCutoverDeps {
  readonly store: CutoverStateStore;
  readonly quiesceOld: (state: CutoverState) => Promise<void>;
  readonly handoffKey: (state: CutoverState) => Promise<void>;
  readonly activateCandidate: (state: CutoverState) => Promise<void>;
  readonly candidateReady: (state: CutoverState) => Promise<void>;
  readonly drainGateway: (state: CutoverState) => Promise<void>;
  readonly switchGatewayToCandidate: (state: CutoverState) => Promise<void>;
  readonly observeCandidate: (state: CutoverState) => Promise<void>;
  /** Best-effort cleanup that runs only after `committed` is durable. */
  readonly retireOld: (state: CutoverState) => Promise<void>;
  readonly quiesceCandidate: (state: CutoverState) => Promise<void>;
  readonly activateOld: (state: CutoverState) => Promise<void>;
  readonly switchGatewayToOld: (state: CutoverState) => Promise<void>;
}

const ROLLBACK_PHASES = new Set<CutoverPhase>([
  'rollback-quiescing-candidate',
  'rollback-activating-old',
  'rollback-switching-gateway',
  'rolled-back',
]);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;

function validateState(state: CutoverState): void {
  if (!ID.test(state.operationId)) throw new Error('cutover operation id is invalid');
  if (!Number.isSafeInteger(state.oldGeneration) || state.oldGeneration < 0)
    throw new Error('old generation is invalid');
  if (
    !Number.isSafeInteger(state.candidateGeneration) ||
    state.candidateGeneration <= state.oldGeneration
  )
    throw new Error('candidate generation must forward-fence the old generation');
  if (!CONTAINER_ID.test(state.oldContainerId) || !CONTAINER_ID.test(state.candidateContainerId))
    throw new Error('cutover container identity is invalid');
  if (state.oldContainerId === state.candidateContainerId)
    throw new Error('cutover generations must use distinct containers');
}

async function beginRollback(store: CutoverStateStore, state: CutoverState): Promise<CutoverState> {
  if (ROLLBACK_PHASES.has(state.phase)) return state;
  if (state.phase === 'standby' || state.phase === 'quiescing-old')
    throw new Error('cutover failed before the old generation was fenced');
  return store.transition(state.phase, 'rollback-quiescing-candidate');
}

async function resumeRollback(
  deps: UpdateCutoverDeps,
  initial: CutoverState,
): Promise<CutoverState> {
  let state = initial;
  if (state.phase === 'rollback-quiescing-candidate') {
    await deps.quiesceCandidate(state);
    state = await deps.store.transition(state.phase, 'rollback-activating-old');
  }
  if (state.phase === 'rollback-activating-old') {
    await deps.activateOld(state);
    state = await deps.store.transition(state.phase, 'rollback-switching-gateway');
  }
  if (state.phase === 'rollback-switching-gateway') {
    await deps.switchGatewayToOld(state);
    state = await deps.store.transition(state.phase, 'rolled-back');
  }
  return state;
}

/**
 * Resume a cutover from durable intent. Every callback must be idempotent and
 * bound to the operation and container identities in `state`.
 */
async function resumeExclusive(deps: UpdateCutoverDeps): Promise<CutoverState> {
  let state = await deps.store.read();
  validateState(state);
  if (state.phase === 'rolled-back') return state;
  if (state.phase === 'committed') {
    await deps.retireOld(state);
    return state;
  }
  if (ROLLBACK_PHASES.has(state.phase)) return resumeRollback(deps, state);

  try {
    if (state.phase === 'standby') state = await deps.store.transition('standby', 'quiescing-old');
    if (state.phase === 'quiescing-old') {
      await deps.quiesceOld(state);
      state = await deps.store.transition(state.phase, 'handing-off-key');
    }
    if (state.phase === 'handing-off-key') {
      await deps.handoffKey(state);
      state = await deps.store.transition(state.phase, 'activating-candidate');
    }
    if (state.phase === 'activating-candidate') {
      await deps.activateCandidate(state);
      state = await deps.store.transition(state.phase, 'checking-candidate');
    }
    if (state.phase === 'checking-candidate') {
      await deps.candidateReady(state);
      state = await deps.store.transition(state.phase, 'draining-gateway');
    }
    if (state.phase === 'draining-gateway') {
      await deps.drainGateway(state);
      state = await deps.store.transition(state.phase, 'switching-gateway');
    }
    if (state.phase === 'switching-gateway') {
      await deps.switchGatewayToCandidate(state);
      state = await deps.store.transition(state.phase, 'observing-candidate');
    }
    if (state.phase === 'observing-candidate') {
      await deps.observeCandidate(state);
      state = await deps.store.transition(state.phase, 'committed');
    }
  } catch (error) {
    const current = await deps.store.read();
    validateState(current);
    if (current.phase === 'standby' || current.phase === 'quiescing-old') throw error;
    const rollback = await beginRollback(deps.store, current);
    try {
      await resumeRollback(deps, rollback);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'cutover and rollback failed', {
        cause: rollbackError,
      });
    }
    throw error;
  }
  // Cleanup is intentionally outside the rollback catch. Once `committed` is
  // durable, failure to remove the stopped old container is a retryable leak,
  // never a reason to reverse a successful route switch.
  await deps.retireOld(state);
  return state;
}

export async function resumeUpdateCutover(deps: UpdateCutoverDeps): Promise<CutoverState> {
  return deps.store.runExclusive(() => resumeExclusive(deps));
}
