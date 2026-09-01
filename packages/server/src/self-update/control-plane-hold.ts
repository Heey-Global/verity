import {
  CONTROL_PLANE_RECONNECT_BUDGET_MS,
  CONTROL_PLANE_RECONNECT_INTERVAL_MS,
  holdPostgresControlPlaneLock,
  isPostgresConnectionClassError,
  PostgresAdvisoryLockHeldError,
  PostgresControlPlaneGenerationTakenError,
  PostgresControlPlaneUnreachableError,
  type PostgresAdvisoryLock,
} from '@verity/store';
import {
  GenerationFenceLostError,
  type ControlPlaneGenerationFence,
} from './control-plane-generation.js';

/**
 * Holding the control-plane generation for the life of a Server process
 * (ADR 0008 D7).
 *
 * The generation answers one question — which Server *is* the control plane —
 * and PostgreSQL is its only authority. A Server claims it before it opens a
 * listener, holds it while it serves, and hands it back when it stops, so a
 * successor can compare-and-swap its way to a newer one. Nothing here is
 * time-based: the caller holds PostgreSQL's session-level exclusive process
 * lock throughout. A successor cannot reach this code while its predecessor's
 * database session is alive, and PostgreSQL releases the lock on a hard crash.
 */

/** Identity of a claim, in the shape the fence's own assertions expect. */
export interface HeldControlPlaneGeneration {
  readonly generation: number;
  readonly holderId: string;
  readonly operationId: string;
}

/**
 * A read-modify-write against a single row loses at most one race per pass:
 * every loss reveals a concrete newer state, so the next pass classifies it
 * rather than repeating a guess. Three passes is a bound, not a retry budget.
 */
const CLAIM_PASSES = 3;

export async function claimControlPlaneGeneration(options: {
  fence: ControlPlaneGenerationFence;
  holderId: string;
  operationId: string;
  /** Caller holds the database-scoped, session-level exclusive process lock. */
  exclusiveProcessLock: true;
}): Promise<HeldControlPlaneGeneration> {
  const { fence, holderId, operationId } = options;
  for (let pass = 0; pass < CLAIM_PASSES; pass += 1) {
    const current = await fence.read();
    if (current === null) {
      // Losing this race is not a failure: the next pass reads whatever the
      // winner wrote and treats it like any other pre-existing state.
      if (await fence.initialize(holderId, operationId))
        return { generation: 1, holderId, operationId };
      continue;
    }
    if (current.state === 'quiesced') {
      const acquired = await fence.acquire({
        expectedGeneration: current.generation,
        holderId,
        operationId,
      });
      if (acquired === null) continue;
      return { generation: acquired.generation, holderId, operationId };
    }
    // The session-level PostgreSQL lock proves no other live Server connected to
    // this database can still be active. It is therefore safe to forward-fence
    // a row left active by a hard kill, database restore, or interrupted close.
    await fence.quiesce(current);
    continue;
  }
  throw new Error('control-plane generation could not be claimed');
}

export interface OpenProcessLockOptions {
  readonly connectionString: string;
  readonly onLost: (error: Error) => void;
  /** Wait out an incumbent that still holds the lock (the activation gate). */
  readonly waitForActivation: boolean;
  /** How long a not-yet-answering database may be waited out at startup. */
  readonly connectBudgetMs?: number;
  readonly connectIntervalMs?: number;
  /** Poll interval while a live incumbent holds the lock. */
  readonly activationIntervalMs?: number;
  /** Seams for tests; both default to the real thing. */
  readonly hold?: typeof holdPostgresControlPlaneLock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (error: unknown) => void;
}

/**
 * Take the PostgreSQL control-plane process lock, waiting out the two things
 * that are not verdicts.
 *
 * A LIVE INCUMBENT (`PostgresAdvisoryLockHeldError`) is waited out only while
 * this process is a candidate waiting for its activation gate — otherwise
 * another Server owning the control plane is a correct reason to refuse to
 * start, and always has been.
 *
 * A DATABASE THAT IS NOT ANSWERING YET is waited out unconditionally, and that
 * is new. Compose's `depends_on: service_healthy` orders the FIRST start; it
 * does nothing for a Postgres recreated under an already-running deployment. In
 * the incident, the Server that restarted after the first crash raced its own
 * not-yet-ready Postgres and died on a plain `ECONNREFUSED` — a second outage
 * caused entirely by the recovery from the first. Fixing only the keeper would
 * have left this one exactly as it was.
 */
export async function openControlPlaneProcessLock(
  options: OpenProcessLockOptions,
): Promise<PostgresAdvisoryLock> {
  const hold = options.hold ?? holdPostgresControlPlaneLock;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        // Deliberately REFERENCED, unlike the heartbeat timer below. This wait
        // runs at startup, before the HTTP listener exists and while the failed
        // client holds no socket, so an unref'ed timer would leave the event
        // loop with nothing to keep it alive: Node would exit 0 in the middle
        // of the wait and the Server would again die on a database that was
        // merely restarting - the exact failure this function exists to
        // prevent. The heartbeat timer is unref'ed because a running Server is
        // already held open by its listener.
        setTimeout(resolve, ms);
      }));
  const budgetMs = options.connectBudgetMs ?? CONTROL_PLANE_RECONNECT_BUDGET_MS;
  const intervalMs = options.connectIntervalMs ?? CONTROL_PLANE_RECONNECT_INTERVAL_MS;
  // Armed by the first connection failure rather than at entry, and disarmed
  // again by every wait on the activation gate.
  //
  // The budget times SILENCE FROM THE DATABASE. Time spent waiting out a live
  // incumbent is not that: a candidate can legitimately sit on its activation
  // gate for minutes while the predecessor finishes draining. Charging that to
  // the same budget would leave it already spent by the time the hand-over
  // completes, so the first transient `ECONNREFUSED` afterwards would be
  // re-thrown instead of waited out — the Server would die on precisely the
  // restart this function exists to survive, and only on the slow hand-overs
  // where the window matters most.
  let deadline: number | undefined;
  for (;;) {
    try {
      return await hold(options.connectionString, options.onLost);
    } catch (error) {
      if (error instanceof PostgresAdvisoryLockHeldError && options.waitForActivation) {
        deadline = undefined;
        await sleep(options.activationIntervalMs ?? 250);
        continue;
      }
      if (!isPostgresConnectionClassError(error)) throw error;
      // `??=`, so a RUN of failures shares one deadline instead of renewing it
      // on each attempt; `>=`, so `connectBudgetMs: 0` still means "do not wait
      // at all" rather than granting one free retry.
      deadline ??= Date.now() + budgetMs;
      if (Date.now() >= deadline) throw error;
      options.onRetry?.(error);
      await sleep(intervalMs);
    }
  }
}

/**
 * WHY a Server is giving the control plane up.
 *
 * Carried rather than assumed, because the four cases are not the same event
 * and the operator needs to be told which one happened. Before this existed,
 * every loss logged "generation lost to another Server", including the case
 * where no other Server was involved at all — which cost real diagnostic time
 * during a Postgres restart that no one had read as a database outage.
 */
export type ControlPlaneLoss =
  | { readonly kind: 'generation-taken' }
  | { readonly kind: 'process-lock-taken' }
  | { readonly kind: 'unreachable'; readonly error: Error }
  | { readonly kind: 'unexpected'; readonly error: Error };

/**
 * Classify what the keeper established before it gave up.
 *
 * The default matters more than the three named cases. Anything else — a
 * rejected credential, a protocol or query error, a bug thrown out of the
 * generation proof — is still a reason to stop, but it establishes NOTHING
 * about who holds the generation. Calling it a takeover would repeat, one level
 * up, the exact mistake this whole path exists to correct, so it gets a kind
 * whose only claim is that the keeper failed.
 */
export function classifyKeeperLoss(error: Error): ControlPlaneLoss {
  if (error instanceof PostgresAdvisoryLockHeldError) return { kind: 'process-lock-taken' };
  if (error instanceof PostgresControlPlaneUnreachableError) return { kind: 'unreachable', error };
  if (error instanceof PostgresControlPlaneGenerationTakenError)
    return { kind: 'generation-taken' };
  return { kind: 'unexpected', error };
}

export interface ControlPlaneHold {
  readonly held: HeldControlPlaneGeneration;
  /** Stop watching without giving the generation up. */
  stop(): void;
  /**
   * Stop watching and hand the generation to a successor. Resolves `false` when
   * the fence was already gone, which is not an error at shutdown.
   */
  release(): Promise<boolean>;
}

export interface ControlPlaneHoldOptions {
  readonly fence: ControlPlaneGenerationFence;
  readonly held: HeldControlPlaneGeneration;
  readonly heartbeatMs?: number;
  /** Called at most once, only when the generation is provably held elsewhere. */
  readonly onLost: () => void;
  /** Called for every heartbeat that failed for any other reason. */
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * Watch a claim that this process already holds.
 *
 * In the normal lifecycle this never fires: a generation changes hands only
 * when its holder quiesces, and that is this process's own decision. The
 * heartbeat exists for the states nothing else can catch — a database restored
 * from a backup, a row edited by hand, a successor that was activated while
 * this Server was unreachable. Those are rare and severe, which is why losing
 * the fence is reported rather than absorbed.
 */
export function watchControlPlaneGeneration(options: ControlPlaneHoldOptions): ControlPlaneHold {
  const { fence, held } = options;
  let lost = false;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const tick = (): void => {
    if (stopped || inFlight !== undefined) return;
    inFlight = fence
      .assertActive(held)
      .catch((error: unknown) => {
        // A heartbeat that could not reach PostgreSQL proves nothing about who
        // holds the generation. Only the fence's own verdict may stop a Server.
        if (!(error instanceof GenerationFenceLostError)) {
          options.onError?.(error);
          return;
        }
        if (lost || stopped) return;
        lost = true;
        clearInterval(timer);
        options.onLost();
      })
      .finally(() => {
        inFlight = undefined;
      });
  };
  const timer = setInterval(tick, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  // The heartbeat must never be the reason the process stays alive.
  timer.unref();
  // Do not leave a startup-sized blind window before the first interval.
  tick();
  return {
    held,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    release: async (): Promise<boolean> => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      if (lost) return false;
      return await fence.quiesce({ ...held, state: 'active' });
    },
  };
}
