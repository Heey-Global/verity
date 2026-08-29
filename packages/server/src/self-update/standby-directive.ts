/**
 * What the Updater needs the outgoing Server to be doing (ADR 0008 D7/D9).
 *
 * Cutover used to make the outgoing Server stop being the control plane by
 * stopping its container. That works, but it throws away the process along with
 * the role: the unlocked data key goes with it, and a rollback has to start a
 * container and wait for it to boot before traffic can move back. The ADR asks
 * for the other thing — the old Server acknowledges `quiesced` and stays alive,
 * so the maintenance window closes on a process that is still there.
 *
 * This module is the vocabulary both sides use for that. It is deliberately not
 * a command channel: the Updater runs with `network_mode: none` and holds the
 * Docker socket, so it can never call into a Server, and every exchange between
 * the two is a Server polling the Updater's control socket. What the Updater
 * publishes is therefore a *directive* — the state the update implies — and
 * what a Server publishes back is an acknowledgement of the state it reached.
 *
 * Almost all of the directive is derived from the journal rather than stored,
 * which is what makes it crash-safe for free: an Updater that dies mid-cutover
 * and resumes republishes exactly the directive its phase implies, with no
 * state to reconcile. The single exception is the moment the quiesce is first
 * asked for — see {@link standbyDirectiveForPhase}.
 */

/** The two things a managed Server can be asked to be. */
export type StandbyDirective =
  /** The control plane: holding the generation, listening, scheduling. */
  | 'serving'
  /** Alive, holding the key, holding nothing else — the standby of ADR 0008. */
  | 'quiesced';

export interface StandbyDirectiveState {
  readonly directive: StandbyDirective;
  /**
   * The operation the directive belongs to (`generation-<n>`), which is also
   * how a Server tells whether the directive is aimed at it.
   *
   * It names the operation that is promoting a candidate, so it equals the
   * `VERITY_UPDATE_ID` of the *candidate* and never of the Server being
   * replaced. A Server that finds its own operation id here is the incoming
   * generation reading a directive written about someone else, and ignores it —
   * without that check, a promoted candidate would read `quiesced` and quiesce
   * itself the moment it started serving.
   */
  readonly operationId: string;
  /** What a Server last reported reaching for this operation, if anything. */
  readonly acknowledged: StandbyDirective | null;
}

/**
 * Journal phases during which the outgoing Server must not be the control plane
 * whatever else is true.
 *
 * The list starts one phase AFTER the quiesce is asked for and runs to the end
 * of the forward path, including `committed` — the old container is removed
 * there, and asking a Server to serve again in the instant before it is retired
 * would be an outage, not a rescue. `rolled-back`, `standby`, and everything
 * before it are absent on purpose: those are the states in which the old
 * generation is, or is becoming, the live one again.
 */
const QUIESCED_PHASES: ReadonlySet<string> = new Set([
  'handing-off-key',
  'activating-candidate',
  'checking-candidate',
  'draining-gateway',
  'switching-gateway',
  'observing-candidate',
  'committed',
  'rollback-quiescing-candidate',
]);

/**
 * The phase in which the quiesce is asked for, and the one phase whose
 * directive is not decided by the journal alone.
 *
 * `quiescing-old` is journalled *before* the Gateway enters maintenance and
 * drains, and draining is the point: it is what lets requests already in flight
 * finish against a Server that is still listening. If the phase by itself meant
 * `quiesced`, a Server polling for its directive would close those listeners
 * seconds into a drain that is still running, and the drain would be a wait for
 * nothing. So within this phase the cutover asks explicitly, once it has
 * drained — and until it does, the answer is that the old Server keeps serving.
 *
 * That request lives only in the Updater's memory, which costs nothing: an
 * Updater that crashes here comes back to a phase that reads as `serving`, so a
 * standby resumes, and the resumed cutover drains and asks again. Every later
 * phase is journal-derived, so a crash past this point cannot wake a standby
 * that a candidate has already replaced.
 */
const REQUESTING_PHASE = 'quiescing-old';

export function standbyDirectiveForPhase(
  phase: string,
  quiesceRequested: boolean,
): StandbyDirective {
  if (QUIESCED_PHASES.has(phase)) return 'quiesced';
  if (phase === REQUESTING_PHASE && quiesceRequested) return 'quiesced';
  return 'serving';
}

/**
 * The Updater's memory of the current exchange: what it asked for, and what it
 * was told.
 *
 * RAM-only for the same reason the key mailbox is: both halves describe
 * processes that are running right now, and a copy that outlived either of them
 * would be a claim about a state nobody is in. An Updater restart therefore
 * starts from nothing, which reads as "not asked yet, not answered yet" — the
 * cutover then asks again, waits its bounded window, and falls back to stopping
 * the container, which is exactly what it did before standbys existed.
 */
export interface StandbyExchange {
  /** Ask the Server of `operationId`'s predecessor to reach `directive`. */
  request(operationId: string, directive: StandbyDirective): void;
  requested(operationId: string): StandbyDirective | null;
  acknowledged(operationId: string): StandbyDirective | null;
  acknowledge(operationId: string, state: StandbyDirective): void;
  /** Forget everything; used when the control boundary closes. */
  discard(): void;
}

interface ExchangeRecord {
  readonly operationId: string;
  requested: StandbyDirective | null;
  acknowledged: StandbyDirective | null;
}

export function createStandbyExchange(): StandbyExchange {
  // One operation at a time, because the journal only ever has one. Anything
  // under a new id drops the previous record rather than accumulating history
  // no one reads.
  let current: ExchangeRecord | undefined;
  const select = (operationId: string): ExchangeRecord => {
    if (current?.operationId !== operationId)
      current = { operationId, requested: null, acknowledged: null };
    return current;
  };
  return {
    request: (operationId, directive) => {
      const record = select(operationId);
      // An acknowledgement answers the question that was asked. Asking a
      // different one — withdrawing a quiesce, or a rollback asking for the
      // state the cutover asked away — leaves the previous answer describing
      // nothing current, and a waiter that accepted it would act on a claim the
      // Server made about a state it has since left.
      if (record.requested !== directive) record.acknowledged = null;
      record.requested = directive;
    },
    requested: (operationId) => (current?.operationId === operationId ? current.requested : null),
    acknowledged: (operationId) =>
      current?.operationId === operationId ? current.acknowledged : null,
    acknowledge: (operationId, state) => {
      select(operationId).acknowledged = state;
    },
    discard: () => {
      current = undefined;
    },
  };
}

export function parseStandbyDirective(value: unknown): StandbyDirective | null {
  return value === 'serving' || value === 'quiesced' ? value : null;
}
