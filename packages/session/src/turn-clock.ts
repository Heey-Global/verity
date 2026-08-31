/**
 * The clock every deadline in a turn is measured against: wall time minus the
 * spans in which the turn was blocked on an operator decision.
 *
 * A brokered secret tool asks before it runs, and time spent reading that prompt
 * is not the turn's to spend. Counting it killed the turn the approval was
 * authorising — the worker exited, the supervisor marked the turn settled, and
 * the resolved secret arrived with nobody left to consume it.
 *
 * Two rules make the accounting honest, and both are easy to get wrong when the
 * arithmetic is written out at a deadline's own call site:
 *
 * - **Overlapping prompts are excluded once.** A turn may have several decisions
 *   outstanding; only the span where at least one is pending is excluded, so a
 *   nesting counter opens the span and the last answer closes it.
 * - **A budget gives back only what happened inside it.** A decision can already
 *   be pending when a budget opens — the app-server is free to push a tool call
 *   before it answers `turn/start`. Every budget is therefore expressed in
 *   {@link TurnClock.attributableMs} readings rather than in wall time, so a wait
 *   that fell outside the budget's own window cannot be subtracted from it.
 */
export type TurnClock = {
  /** A decision was put to the operator: stop counting until it comes back. */
  beginOperatorWait(this: void): void;
  /** The decision came back, or the wait was abandoned: resume counting. */
  endOperatorWait(this: void): void;
  /**
   * Time since this clock was created, with every operator wait removed —
   * including one still open right now, so a deadline re-checked mid-wait sees a
   * reading that has stopped rather than one that keeps climbing.
   */
  attributableMs(this: void): number;
  /**
   * Open a budget of `budgetMs` attributable milliseconds, starting now. The
   * returned function reports how many are left, and goes negative once the
   * budget is overspent.
   */
  budget(this: void, budgetMs: number): (this: void) => number;
};

/**
 * @param now monotonic by default, and deliberately not `Date.now`: these readings
 *   are re-taken on a tick to decide whether a deadline has passed, so an NTP step
 *   or an administrative clock change would otherwise kill a turn outright or hold
 *   one open indefinitely. Injectable so the accounting can be tested without
 *   wall-clock races.
 */
export function createTurnClock(now: () => number = () => performance.now()): TurnClock {
  const origin = now();
  let pendingDecisions = 0;
  let waitStartedAt = 0;
  let excludedMs = 0;
  const attributableMs = (): number =>
    now() - origin - excludedMs - (pendingDecisions > 0 ? now() - waitStartedAt : 0);
  return {
    beginOperatorWait: () => {
      if (pendingDecisions++ === 0) waitStartedAt = now();
    },
    endOperatorWait: () => {
      // Both the decision and an abort settle the same race, so a wait can be
      // closed twice; the second close must not credit a second span.
      if (pendingDecisions === 0) return;
      if (--pendingDecisions === 0) excludedMs += now() - waitStartedAt;
    },
    attributableMs,
    budget: (budgetMs) => {
      const openedAt = attributableMs();
      return () => budgetMs - (attributableMs() - openedAt);
    },
  };
}

/** How often a deadline is re-checked while a decision may be pending. */
const DEADLINE_TICK_MS = 1_000;
/**
 * The shortest a re-check may be scheduled. A budget with a few milliseconds left
 * when the prompt goes up keeps reporting those milliseconds for as long as the
 * operator takes to answer, so without a floor the tick would rearm itself at that
 * interval for the whole wait. The cost of the floor is that a deadline can fire up
 * to this late, which no turn budget is precise enough to notice.
 */
const DEADLINE_MIN_TICK_MS = 50;

/**
 * Fire `onExpiry` once `remaining()` is spent, re-checking on a tick rather than
 * arming a single timer: a `setTimeout` cannot be told that the clock stopped while
 * an approval card was on screen, and `remaining()` reads a clock that does exactly
 * that (see {@link createTurnClock}). Fires at most once. Returns a canceller.
 */
export function armDeadline(remaining: () => number, onExpiry: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const rearm = (): void => {
    const left = remaining();
    if (left <= 0) {
      onExpiry();
      return;
    }
    timer = setTimeout(rearm, Math.min(Math.max(left, DEADLINE_MIN_TICK_MS), DEADLINE_TICK_MS));
  };
  timer = setTimeout(rearm, Math.min(Math.max(remaining(), 0), DEADLINE_TICK_MS));
  return () => clearTimeout(timer);
}
