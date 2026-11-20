/** Records the milliseconds spent in each named step, in the order they ran. */
export type PhaseTimer = {
  mark(phase: string): void;
  readonly phasesMs: Record<string, number>;
  readonly lastPhase: string | undefined;
  totalMs(): number;
};

export function phaseTimer(): PhaseTimer {
  const startedAt = performance.now();
  let last = startedAt;
  let lastPhase: string | undefined;
  const phasesMs: Record<string, number> = {};
  return {
    mark(phase) {
      const now = performance.now();
      phasesMs[phase] = Math.round(now - last);
      last = now;
      lastPhase = phase;
    },
    phasesMs,
    get lastPhase() {
      return lastPhase;
    },
    totalMs: () => Math.round(performance.now() - startedAt),
  };
}
