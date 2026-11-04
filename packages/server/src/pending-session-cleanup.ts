import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionHomePath } from './session-home.js';

export interface PendingSessionCleanup {
  sessionId: string;
  sandboxCwd: string;
  runnerProjectIds: string[];
  bindings: { backend: string; backendSessionId: string }[];
  progress?: Record<
    string,
    {
      homeDeleted?: boolean;
      artifactsDeleted?: boolean;
      failures?: number;
      retryAt?: number;
      parked?: string;
    }
  >;
}

function recordPath(root: string, id: string): string {
  return `${sessionHomePath(root, id)}.json`;
}

/** Outside session foreign-key cascades: a failed cleanup must retain ownership. */
export async function queueSessionCleanup(
  root: string,
  record: PendingSessionCleanup,
): Promise<void> {
  await mkdir(join(root, 'session-homes'), { recursive: true, mode: 0o700 });
  const path = recordPath(root, record.sessionId);
  const temporary = `${path}.${randomUUID()}`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function finishSessionCleanup(root: string, id: string): Promise<void> {
  await rm(recordPath(root, id), { force: true });
}

export async function pendingSessionCleanups(root: string): Promise<PendingSessionCleanup[]> {
  const directory = join(root, 'session-homes');
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const records: PendingSessionCleanup[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const file = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size > 65536) throw new Error('Invalid pending session cleanup');
      const record = JSON.parse(await file.readFile('utf8')) as PendingSessionCleanup;
      if (
        recordPath(root, record.sessionId) !== join(directory, entry.name) ||
        typeof record.sandboxCwd !== 'string' ||
        !Array.isArray(record.bindings) ||
        !Array.isArray(record.runnerProjectIds) ||
        record.runnerProjectIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
      )
        throw new Error('Invalid pending session cleanup');
      if (
        record.progress !== undefined &&
        (typeof record.progress !== 'object' ||
          record.progress === null ||
          Array.isArray(record.progress) ||
          Object.entries(record.progress).some(
            ([id, value]) =>
              !record.runnerProjectIds.includes(id) ||
              typeof value !== 'object' ||
              value === null ||
              (value.retryAt !== undefined &&
                (!Number.isFinite(value.retryAt) || value.retryAt < 0)) ||
              (value.failures !== undefined &&
                (!Number.isSafeInteger(value.failures) || value.failures < 0)) ||
              (value.homeDeleted !== undefined && typeof value.homeDeleted !== 'boolean') ||
              (value.artifactsDeleted !== undefined &&
                typeof value.artifactsDeleted !== 'boolean') ||
              (value.parked !== undefined && typeof value.parked !== 'string'),
          ))
      )
        throw new Error('Invalid pending session cleanup progress');
      records.push(record);
    } finally {
      await file.close();
    }
  }
  return records;
}

/** Retain step ownership across sleep and retry without widening filesystem permissions. */
export function createSessionCleanupProcessor(options: {
  root: string;
  sessionExists: (sessionId: string) => Promise<boolean>;
  runtimeState: (projectId: string) => Promise<'absent' | 'ready' | 'sleeping' | 'unavailable'>;
  deleteHome: (projectId: string, record: PendingSessionCleanup) => Promise<void>;
  purgeArtifacts: (
    projectId: string,
    record: PendingSessionCleanup,
  ) => Promise<'clean' | 'retry' | 'unsafe'>;
  report: (
    projectId: string,
    record: PendingSessionCleanup,
    reason: 'retry' | 'unsafe',
    error?: unknown,
  ) => void;
  now?: () => number;
  stopped?: () => boolean;
}): { run: (readyProjectId?: string) => Promise<void> } {
  let tail = Promise.resolve();
  const now = options.now ?? Date.now;
  const scan = async (readyProjectId?: string): Promise<void> => {
    for (const record of await pendingSessionCleanups(options.root)) {
      if (options.stopped?.()) return;
      if (await options.sessionExists(record.sessionId)) continue;
      if (readyProjectId !== undefined && !record.runnerProjectIds.includes(readyProjectId))
        continue;
      const previous = JSON.stringify(record);
      const progress = (record.progress ??= {});
      let admissionFailure: unknown;
      for (const projectId of record.runnerProjectIds) {
        if (readyProjectId !== undefined && readyProjectId !== projectId) continue;
        const step = Object.hasOwn(progress, projectId)
          ? progress[projectId]!
          : (progress[projectId] = {});
        if (step.homeDeleted && step.artifactsDeleted) continue;
        const state = await options.runtimeState(projectId);
        if (state === 'absent') {
          step.homeDeleted = true;
          step.artifactsDeleted = true;
          continue;
        }
        const admission = projectId === readyProjectId;
        if (!admission && (step.parked || (step.retryAt ?? 0) > now())) continue;
        if (!admission && state !== 'ready') continue;
        let retry = false;
        let error: unknown;
        if (!step.homeDeleted && (admission || state === 'ready')) {
          try {
            await options.deleteHome(projectId, record);
            step.homeDeleted = true;
          } catch (cause) {
            retry = true;
            error = cause;
            if (admission) admissionFailure = cause;
          }
        }
        // The broker must fence late writers before any independent artifact purge.
        if (!step.artifactsDeleted && !step.parked && step.homeDeleted) {
          try {
            const result = await options.purgeArtifacts(projectId, record);
            if (result === 'clean') step.artifactsDeleted = true;
            else if (result === 'unsafe') {
              step.parked = 'unsafe-artifact-path';
              options.report(projectId, record, 'unsafe');
            } else retry = true;
          } catch (cause) {
            retry = true;
            error = cause;
          }
        }
        if (retry) {
          step.failures = Math.min(32, (step.failures ?? 0) + 1);
          step.retryAt = now() + Math.min(1_800_000, 30_000 * 2 ** Math.min(step.failures - 1, 6));
          // A durable first-error report avoids repeating the same warning after restarts.
          if (step.failures === 1) options.report(projectId, record, 'retry', error);
        } else {
          step.failures = 0;
          step.retryAt = 0;
        }
      }
      if (
        record.runnerProjectIds.every(
          (id) => progress[id]?.homeDeleted && progress[id]?.artifactsDeleted,
        )
      )
        await finishSessionCleanup(options.root, record.sessionId);
      else if (JSON.stringify(record) !== previous) await queueSessionCleanup(options.root, record);
      if (admissionFailure !== undefined) throw admissionFailure;
    }
  };
  return {
    run: (readyProjectId) => {
      const operation = tail.then(() => scan(readyProjectId));
      tail = operation.catch(() => undefined);
      return operation;
    },
  };
}

/** One serial worker: retries survive failed requests and do not overlap slow supervisor calls. */
export function createSessionCleanupWorker(
  scan: () => Promise<void>,
  onError: (error: unknown) => void,
  intervalMs = 30_000,
): {
  start: () => void;
  run: () => void;
  stop: () => void;
  settled: () => Promise<void> | undefined;
} {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let requested = false;
  let stopped = false;
  const run = (): void => {
    if (stopped) return;
    requested = true;
    if (active) return;
    active = (async () => {
      while (requested && !stopped) {
        requested = false;
        try {
          await scan();
        } catch (error) {
          onError(error);
        }
      }
    })().finally(() => {
      active = undefined;
    });
  };
  return {
    run,
    start: () => {
      if (timer || stopped) return;
      timer = setInterval(run, intervalMs);
      timer.unref();
      run();
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    settled: () => active,
  };
}
