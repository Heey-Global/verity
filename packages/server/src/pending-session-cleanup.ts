import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requestRunnerSupervisor } from '@verity/session';
import { sessionHomePath } from './session-home.js';

/**
 * How long the Server waits for the Runner supervisor to answer
 * `delete-session-home`. The supervisor first scans the project's turn
 * directories and cancels the session's turns that are still in flight, then
 * hands the deletion to the spawn broker and allows that step 30 s without a
 * reply (`brokerStorageRequest` in verity-runner-supervisor.mjs). Inside the
 * Sandbox every file operation is a round trip through the runtime, so a
 * project with a long turn history makes the scan itself take seconds, before
 * the broker fences late starts, removes the home and purges legacy native
 * state. A shorter Server deadline abandons a deletion the supervisor still
 * owns: the request reports a timeout although it may yet succeed, and a
 * failed Repair then stops the container mid-deletion. The deadline therefore
 * exceeds the supervisor's own storage budget, so its answer, success or a
 * bounded failure, is what the Server records.
 */
export const SESSION_HOME_DELETE_TIMEOUT_MS = 60_000;

/** Delete one session home through the project's Runner supervisor. Only an
 *  explicit `ok: true` answer counts as deleted. */
export async function deleteRunnerSessionHome(
  socketPath: string,
  sessionId: string,
  timeoutMs = SESSION_HOME_DELETE_TIMEOUT_MS,
): Promise<void> {
  // requestRunnerSupervisor resolves only an explicit `ok: true` answer.
  await requestRunnerSupervisor(socketPath, { kind: 'delete-session-home', sessionId }, timeoutMs);
}

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
        // A project's runtime, or a person's own (`u<tag>/<project>`, ADR 0023 §4).
        record.runnerProjectIds.some(
          (id) => !/^(?:u[0-9a-f]{16}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id),
        )
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
  refreshBindings?: (sessionId: string) => Promise<PendingSessionCleanup['bindings']>;
  now?: () => number;
  stopped?: () => boolean;
}): {
  run: (readyProjectId?: string) => Promise<void>;
  runSession: (sessionId: string, captured?: PendingSessionCleanup) => Promise<void>;
} {
  const tails = new Map<string, Promise<void>>();
  const now = options.now ?? Date.now;
  const processRecord = async (
    record: PendingSessionCleanup,
    readyProjectId?: string,
  ): Promise<void> => {
    if (options.stopped?.() || (await options.sessionExists(record.sessionId))) return;
    // The session's absence proves the cascade-time snapshot committed. Read it
    // here, not before the existence check, so a concurrent delete cannot race it.
    const retained = await options.refreshBindings?.(record.sessionId);
    if (retained) {
      const bindings = [
        ...new Map(
          [...record.bindings, ...retained].map((binding) => [
            JSON.stringify([binding.backend, binding.backendSessionId]),
            binding,
          ]),
        ).values(),
      ];
      if (bindings.length > record.bindings.length) {
        record.bindings = bindings;
        for (const step of Object.values(record.progress ?? {})) {
          step.artifactsDeleted = false;
          step.retryAt = 0;
        }
        await queueSessionCleanup(options.root, record);
      }
    }
    const previous = JSON.stringify(record);
    const progress = (record.progress ??= {});
    let admissionFailure: Error | undefined;
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
          if (admission)
            admissionFailure =
              cause instanceof Error
                ? cause
                : new Error('Pending session home cleanup failed', { cause });
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
  };
  const scan = async (
    readyProjectId?: string,
    sessionId?: string,
    captured?: PendingSessionCleanup,
  ): Promise<void> => {
    const records = await pendingSessionCleanups(options.root);
    if (captured && !records.some((record) => record.sessionId === captured.sessionId))
      records.push(captured);
    for (const pending of records) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      if (readyProjectId !== undefined && !pending.runnerProjectIds.includes(readyProjectId))
        continue;
      const previous = tails.get(pending.sessionId) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          // Re-read under this session's ownership; another scan may have completed it.
          const saved = (await pendingSessionCleanups(options.root)).find(
            (record) => record.sessionId === pending.sessionId,
          );
          const current = saved ?? captured;
          if (!current) return;
          if (captured) {
            const bindings = [
              ...new Map(
                [...current.bindings, ...captured.bindings].map((binding) => [
                  JSON.stringify([binding.backend, binding.backendSessionId]),
                  binding,
                ]),
              ).values(),
            ];
            const added = bindings.length > current.bindings.length;
            current.bindings = bindings;
            current.runnerProjectIds = [
              ...new Set([...current.runnerProjectIds, ...captured.runnerProjectIds]),
            ];
            if (added)
              for (const step of Object.values(current.progress ?? {})) {
                step.artifactsDeleted = false;
                step.retryAt = 0;
              }
            // Recreate an earlier job that already finished before final capture.
            if (!saved || added) await queueSessionCleanup(options.root, current);
          }
          await processRecord(current, readyProjectId);
        });
      tails.set(pending.sessionId, operation);
      try {
        await operation;
      } finally {
        if (tails.get(pending.sessionId) === operation) tails.delete(pending.sessionId);
      }
    }
  };
  return {
    run: (projectId) => scan(projectId),
    runSession: (id, captured) => scan(undefined, id, captured),
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
