/**
 * The outgoing Server's live quiesced standby (ADR 0008 D7/D8/D9).
 *
 * Cutover used to stop the old container: the process died, its memory went
 * with it, and a rollback had to start a container and wait for it to boot
 * before traffic could move back. That is the last gap between what ADR 0008
 * decided and what ships — the ADR asks for the old Server to *acknowledge*
 * `quiesced` and stay alive, so the maintenance window closes on a process that
 * is still there to route back to.
 *
 * Quiescing means giving up everything that makes a process the control plane
 * while keeping the process itself: it stops serving and scheduling, releases
 * the control-plane generation, and closes the database pools — which is what
 * drops the last shared PostgreSQL lock and lets the successor take the
 * exclusive form of it. What survives is the process, its memory, and the
 * unlocked data key, which is precisely what a rollback and the D8 handoff
 * need and what stopping the container threw away.
 *
 * Resuming is not undoing. A resumed Server builds a *new* serving stack and
 * CAS-acquires a *newer* generation, because the ADR forbids restoring an old
 * generation number: stale commands from the failed successor must be rejected
 * by the fence, and that only works if the number moved forward. So this is a
 * lifecycle over incarnations, not a pause button — the only thing carried from
 * one incarnation to the next is the key.
 */

/** One live incarnation: a built, listening, generation-holding Server. */
export interface ServingStack {
  /**
   * Give up serving and every authority that goes with it, in that order.
   *
   * The ordering is the contract, and it lives in the implementation the caller
   * injects (`main`'s ordered shutdown): stop accepting work, close the
   * listeners, hand the generation back, then release the keeper lock last. A
   * successor may only reach the exclusive lock once this has resolved.
   */
  close(mode: 'handoff' | 'shutdown'): Promise<void>;
  /** The unlocked data key, or undefined while this Server is sealed. */
  exportKeyMaterial(): string | undefined;
}

export interface StandbyLifecycleDeps {
  /**
   * Build, claim, and listen — the whole startup path, once more.
   *
   * `adoptedSecretKeyMaterial` is the key the previous incarnation held, so a
   * resumed Server comes back unsealed rather than at a master-password prompt.
   * It is the same input the promoted Server adopts a handed-off key through
   * (ADR 0008 D8); a resume is just this process being its own predecessor.
   */
  readonly start: (input: { adoptedSecretKeyMaterial?: string }) => Promise<ServingStack>;
}

export type StandbyLifecycleState =
  /** Serving, holding the generation — the ordinary state of a live Server. */
  | 'serving'
  /** Serving nothing, holding nothing, still alive and still holding the key. */
  | 'quiesced'
  /** Deliberately over. The process is on its way out. */
  | 'stopped'
  /**
   * A teardown did not finish, so what this process still owns is unknown.
   *
   * Unknown authority is the one state that may not be waited out: it can
   * neither serve (it does not know that it may) nor be resumed (a claim would
   * race whatever was left behind). The process must go away and let PostgreSQL
   * release the session locks the way it does for any hard failure.
   */
  | 'failed';

export interface StandbyLifecycle {
  readonly state: StandbyLifecycleState;
  /**
   * Stop serving without dying. Resolves once the successor may claim the
   * exclusive lock. A no-op when already quiesced, so a repeated cutover step
   * is safe.
   */
  quiesce(): Promise<void>;
  /**
   * Come back as a new incarnation under a newer generation. A no-op when
   * already serving. A failed resume leaves this quiesced and retryable — the
   * usual reason is a successor that has not released the lock yet.
   */
  resume(): Promise<void>;
  /** Terminal teardown. Nothing may serve or resume afterwards. */
  stop(): Promise<void>;
  /**
   * The unlocked key this process is holding, across incarnations.
   *
   * Read from the live stack while serving and from the retained copy while
   * quiesced. That retention IS the standby: without it, quiescing would seal
   * the Server as thoroughly as stopping the container did.
   */
  keyMaterial(): string | undefined;
}

/**
 * @param stack the incarnation that is already serving. The caller has just
 * completed startup, so the lifecycle begins in `serving` rather than building
 * anything itself — a Server that failed to start never gets this far.
 */
export function createStandbyLifecycle(
  stack: ServingStack,
  deps: StandbyLifecycleDeps,
): StandbyLifecycle {
  let state: StandbyLifecycleState = 'serving';
  let current: ServingStack | undefined = stack;
  /** The key of the incarnation that was closed, kept while quiesced. */
  let retainedKeyMaterial: string | undefined;
  /**
   * Transitions are serialized on one chain, so a cutover step and a rollback
   * that arrive at once cannot interleave: whichever lands second sees the
   * state the first one produced. Rejections are absorbed here and re-thrown to
   * the caller that owns the transition, so one failed resume does not poison
   * every later transition.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = async <T>(step: () => Promise<T>): Promise<T> => {
    const run = queue.then(step, step);
    queue = run.catch(() => undefined);
    return run;
  };

  /** Close the live incarnation, keeping its key and forgetting the stack. */
  const teardown = async (mode: 'handoff' | 'shutdown'): Promise<void> => {
    const closing = current;
    if (closing === undefined) return;
    // Read the key BEFORE the close: afterwards there is no one left to ask,
    // and this is the whole reason the process stays alive.
    retainedKeyMaterial = closing.exportKeyMaterial();
    current = undefined;
    try {
      await closing.close(mode);
    } catch (error) {
      state = 'failed';
      throw error;
    }
  };

  return {
    get state() {
      return state;
    },

    keyMaterial: () => current?.exportKeyMaterial() ?? retainedKeyMaterial,

    quiesce: () =>
      serialize(async () => {
        if (state === 'quiesced') return;
        if (state !== 'serving') throw new Error(`a ${state} Server cannot be quiesced`);
        await teardown('handoff');
        state = 'quiesced';
      }),

    resume: () =>
      serialize(async () => {
        if (state === 'serving') return;
        if (state !== 'quiesced') throw new Error(`a ${state} Server cannot resume serving`);
        // Left where it was on failure: nothing has been claimed, so quiesced
        // is still an honest description, and the caller may try again once
        // whatever holds the lock has let go.
        const started = await deps.start(
          retainedKeyMaterial === undefined
            ? {}
            : { adoptedSecretKeyMaterial: retainedKeyMaterial },
        );
        current = started;
        retainedKeyMaterial = undefined;
        state = 'serving';
      }),

    stop: () =>
      serialize(async () => {
        if (state === 'stopped') return;
        // A failed teardown still ends here: the caller asked this process to
        // go away, and it is going away either way.
        try {
          await teardown('shutdown');
        } finally {
          retainedKeyMaterial = undefined;
          if (state !== 'failed') state = 'stopped';
        }
      }),
  };
}
