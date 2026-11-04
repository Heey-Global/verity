export type BranchReadStage = 'metadata' | 'pr' | 'identity' | 'localChanges';

/** Observe latency without retaining repository names, user input or command output. */
export async function measureBranchReadStage<T>(
  stage: BranchReadStage,
  read: () => Promise<T>,
  report: (timing: { stage: BranchReadStage; elapsedMs: number }) => void,
  now: () => number = () => performance.now(),
): Promise<T> {
  const startedAt = now();
  try {
    return await read();
  } finally {
    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= 3_000) report({ stage, elapsedMs: Math.round(elapsedMs) });
  }
}
