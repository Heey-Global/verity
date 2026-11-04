/** Fixed categories keep diagnostics bounded and exclude command arguments and identities. */
export const DOCKER_EXEC_PURPOSES = [
  'lifecycle',
  'git',
  'runtime',
  'listener-watch',
  'agent',
] as const;
export type DockerExecPurpose = (typeof DOCKER_EXEC_PURPOSES)[number];

interface ExecCounters {
  started: number;
  active: number;
  peak: number;
  completed: number;
  failed: number;
  eagain: number;
  elapsedMs: number;
  maxElapsedMs: number;
}

function counters(): ExecCounters {
  return {
    started: 0,
    active: 0,
    peak: 0,
    completed: 0,
    failed: 0,
    eagain: 0,
    elapsedMs: 0,
    maxElapsedMs: 0,
  };
}

export function createDockerExecDiagnostics(now: () => number = () => performance.now()) {
  const total = counters();
  const categories = new Map(DOCKER_EXEC_PURPOSES.map((purpose) => [purpose, counters()]));
  const begin = (purpose: DockerExecPurpose): ((error?: unknown) => void) => {
    const category = categories.get(purpose)!;
    const startedAt = now();
    for (const entry of [total, category]) {
      entry.started++;
      entry.active++;
      entry.peak = Math.max(entry.peak, entry.active);
    }
    let finished = false;
    return (error?: unknown) => {
      if (finished) return;
      finished = true;
      const elapsedMs = Math.max(0, now() - startedAt);
      const eagain =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'EAGAIN';
      for (const entry of [total, category]) {
        entry.active--;
        entry.completed++;
        if (error !== undefined) entry.failed++;
        if (eagain) entry.eagain++;
        entry.elapsedMs += elapsedMs;
        entry.maxElapsedMs = Math.max(entry.maxElapsedMs, elapsedMs);
      }
    };
  };
  return {
    begin,
    snapshot: () => ({
      ...total,
      purposes: DOCKER_EXEC_PURPOSES.map((purpose) => ({ purpose, ...categories.get(purpose)! })),
    }),
  };
}

const diagnostics = createDockerExecDiagnostics();
export const beginDockerExecDiagnostic = diagnostics.begin;
export const getDockerExecDiagnostics = diagnostics.snapshot;

export async function measureDockerExec<T>(
  purpose: DockerExecPurpose,
  operation: () => Promise<T>,
): Promise<T> {
  const finish = beginDockerExecDiagnostic(purpose);
  try {
    const value = await operation();
    finish();
    return value;
  } catch (error) {
    finish(error);
    throw error;
  }
}
