import type { UpdateJournal, UpdatePhase } from './update-journal.js';

/**
 * Public projection of the sealed update journal (ADR 0008 D4).
 *
 * The journal is an internal, privileged record: it names container ids and can
 * carry an operator-supplied failure code. Everything a device may see goes
 * through this module, which is deliberately a pure function of the journal —
 * no filesystem paths, no container identities, no free-form messages, and a
 * closed set of failure codes so an unexpected journal value can never become a
 * client-visible string.
 */

export type UpdateOperationState =
  'preparing' | 'prepared' | 'activating' | 'completed' | 'rolling-back' | 'rolled-back' | 'failed';

/** Codes the preparation pipeline can record; anything else projects as `unknown`. */
export const UPDATE_FAILURE_CODES = [
  'requested-failed',
  'pulling-failed',
  'verifying-image-failed',
  'preflight-failed',
  'creating-standby-failed',
] as const;

export type UpdateFailureCode = (typeof UPDATE_FAILURE_CODES)[number] | 'unknown';

/** Ordered forward plan; `step`/`totalSteps` are positions within it. */
const FORWARD_PLAN = [
  'requested',
  'pulling',
  'verifying-image',
  'preflight',
  'creating-standby',
  'standby',
  'quiescing-old',
  'handing-off-key',
  'activating-candidate',
  'checking-candidate',
  'draining-gateway',
  'switching-gateway',
  'observing-candidate',
  'committed',
  'reconciling-companions',
  'completed',
] as const satisfies readonly UpdatePhase[];

/** Rollback is its own plan: progress counts down the recovery, not the update. */
const ROLLBACK_PLAN = [
  'rollback-quiescing-candidate',
  'rollback-activating-old',
  'rollback-switching-gateway',
  'rolled-back',
] as const satisfies readonly UpdatePhase[];

const STATES: readonly UpdateOperationState[] = [
  'preparing',
  'prepared',
  'activating',
  'completed',
  'rolling-back',
  'rolled-back',
  'failed',
];

const PHASES: readonly UpdatePhase[] = [...FORWARD_PLAN, ...ROLLBACK_PLAN, 'failed'];

const DIGEST = /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/;
const UPDATE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;

export interface UpdateOperation {
  readonly updateId: string;
  readonly state: UpdateOperationState;
  readonly phase: UpdatePhase;
  /** 1-based position in the plan named by `state` (forward or rollback). */
  readonly step: number;
  readonly totalSteps: number;
  readonly generation: number;
  readonly previousDigest: string;
  readonly targetDigest: string;
  readonly failureCode: UpdateFailureCode | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** Terminal operations are done; only these may be superseded by a new request. */
export function isTerminalOperationState(state: UpdateOperationState): boolean {
  return state === 'completed' || state === 'rolled-back' || state === 'failed';
}

function stateOf(phase: UpdatePhase): UpdateOperationState {
  if (phase === 'failed') return 'failed';
  if (phase === 'rolled-back') return 'rolled-back';
  if (phase === 'completed') return 'completed';
  if (phase === 'standby') return 'prepared';
  if ((ROLLBACK_PLAN as readonly UpdatePhase[]).includes(phase)) return 'rolling-back';
  const forward = FORWARD_PLAN.indexOf(phase as (typeof FORWARD_PLAN)[number]);
  return forward < FORWARD_PLAN.indexOf('standby') ? 'preparing' : 'activating';
}

function failureCodeOf(journal: UpdateJournal): UpdateFailureCode | null {
  if (journal.failure === null) return null;
  const code = journal.failure.code;
  return (UPDATE_FAILURE_CODES as readonly string[]).includes(code)
    ? (code as UpdateFailureCode)
    : 'unknown';
}

/**
 * A failed operation records only `phase: 'failed'`, so the position it reached
 * is recovered from the closed failure code. An unknown code cannot be located
 * and reports the first step rather than inventing progress.
 */
function failedStep(failureCode: UpdateFailureCode | null): number {
  if (failureCode === null || failureCode === 'unknown') return 1;
  const phase = failureCode.slice(0, -'-failed'.length) as UpdatePhase;
  const index = FORWARD_PLAN.indexOf(phase as (typeof FORWARD_PLAN)[number]);
  return index < 0 ? 1 : index + 1;
}

/** The plan an operation in this state is counted against. */
function planOf(state: UpdateOperationState): readonly UpdatePhase[] {
  return state === 'rolling-back' || state === 'rolled-back' ? ROLLBACK_PLAN : FORWARD_PLAN;
}

/**
 * Progress is a function of the phase alone (plus the failure code, for the one
 * phase that erases its position). Deriving it in one place lets the wire parser
 * insist on the same answer instead of accepting any step inside the plan.
 */
function stepOf(phase: UpdatePhase, failureCode: UpdateFailureCode | null): number {
  if (phase === 'failed') return failedStep(failureCode);
  return planOf(stateOf(phase)).indexOf(phase) + 1 || /* unreachable for known phases */ 1;
}

export function projectUpdateOperation(journal: UpdateJournal): UpdateOperation {
  const state = stateOf(journal.phase);
  const failureCode = failureCodeOf(journal);
  return {
    updateId: journal.updateId,
    state,
    phase: journal.phase,
    step: stepOf(journal.phase, failureCode),
    totalSteps: planOf(state).length,
    generation: journal.generation,
    previousDigest: journal.previousDigest,
    targetDigest: journal.targetDigest,
    failureCode,
    startedAt: journal.createdAt,
    updatedAt: journal.updatedAt,
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

/**
 * Strict wire parser for the projection. Both hops (Server reading the Updater,
 * app reading the Server) validate independently, so a compromised or outdated
 * peer cannot widen the contract.
 */
export function parseUpdateOperation(value: unknown): UpdateOperation | null {
  if (!object(value)) return null;
  const keys = [
    'updateId',
    'state',
    'phase',
    'step',
    'totalSteps',
    'generation',
    'previousDigest',
    'targetDigest',
    'failureCode',
    'startedAt',
    'updatedAt',
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    typeof value.updateId !== 'string' ||
    !UPDATE_ID.test(value.updateId) ||
    !STATES.includes(value.state as UpdateOperationState) ||
    !PHASES.includes(value.phase as UpdatePhase) ||
    !Number.isSafeInteger(value.totalSteps) ||
    !Number.isSafeInteger(value.step) ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.previousDigest !== 'string' ||
    !DIGEST.test(value.previousDigest) ||
    typeof value.targetDigest !== 'string' ||
    !DIGEST.test(value.targetDigest) ||
    !timestamp(value.startedAt) ||
    !timestamp(value.updatedAt)
  )
    return null;
  const state = value.state as UpdateOperationState;
  const phase = value.phase as UpdatePhase;
  const step = value.step as number;
  const totalSteps = value.totalSteps as number;
  const generation = value.generation as number;
  // The phase determines the state outright, in both directions: `failed` is
  // reachable from no other state, and no other state may claim that phase.
  if (totalSteps !== planOf(state).length || generation < 1 || stateOf(phase) !== state)
    return null;
  let failureCode: UpdateFailureCode | null;
  if (value.failureCode === null) failureCode = null;
  else if (
    typeof value.failureCode === 'string' &&
    (value.failureCode === 'unknown' ||
      (UPDATE_FAILURE_CODES as readonly string[]).includes(value.failureCode))
  )
    failureCode = value.failureCode as UpdateFailureCode;
  else return null;
  if ((state === 'failed') !== (failureCode !== null)) return null;
  // The phase already determines the step, so a payload that disagrees is
  // reporting progress its own phase does not support.
  if (step !== stepOf(phase, failureCode)) return null;
  return {
    updateId: value.updateId,
    state,
    phase,
    step,
    totalSteps,
    generation,
    previousDigest: value.previousDigest,
    targetDigest: value.targetDigest,
    failureCode,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
  };
}
