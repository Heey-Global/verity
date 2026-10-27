import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readBounded, writeDurable } from './repository.js';
import type { BackupProbeResult } from './probe.js';

export const probePhase = z.enum([
  'selecting',
  'release',
  'staging',
  'identity',
  'git',
  'database',
  'revocations',
  'cleanup',
]);
export type ProbePhase = z.infer<typeof probePhase>;
const jobSchema = z
  .object({
    format: z.literal(1),
    installationId: z.string().uuid(),
    id: z.string().uuid(),
    status: z.enum(['running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    phase: probePhase,
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().nullable(),
    snapshot: z
      .object({ repository: z.string().max(128), sequence: z.number().int().positive() })
      .strict()
      .nullable(),
    error: z.enum(['probe-failed', 'cleanup-failed', 'timed-out', 'interrupted']).nullable(),
  })
  .strict();
export type ProbeJob = z.infer<typeof jobSchema>;
export interface ProbeJobDependencies {
  root: string;
  installationId: string;
  exclusive: <T>(action: () => Promise<T>) => Promise<T>;
  execute: (
    job: ProbeJob,
    recoveryKey: string,
    signal: AbortSignal,
    phase: (phase: ProbePhase) => Promise<void>,
    selected: (repository: string, sequence: number) => Promise<void>,
  ) => Promise<BackupProbeResult>;
  cleanup: (job: ProbeJob) => Promise<void>;
  verified: (result: BackupProbeResult) => Promise<void>;
  timeoutMs?: number;
}

/** One durable, key-free job record; secrets exist only in the active execution closure. */
export class BackupProbeJobs {
  private current: ProbeJob | undefined;
  private controller: AbortController | undefined;
  private committing = false;
  private writes: Promise<void> = Promise.resolve();
  private constructor(private readonly deps: ProbeJobDependencies) {}
  static async open(deps: ProbeJobDependencies): Promise<BackupProbeJobs> {
    z.string().uuid().parse(deps.installationId);
    const manager = new BackupProbeJobs(deps);
    try {
      manager.current = jobSchema.parse(
        JSON.parse((await readBounded(join(deps.root, 'probe-job'), 8192)).toString()),
      );
      if (manager.current.installationId !== deps.installationId)
        throw new Error('Foreign probe job');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (manager.current) {
      // Only deterministic resources for this installation and this validated UUID are removed.
      await deps.cleanup(manager.current);
      if (manager.current.status === 'running' || manager.current.status === 'cancelling')
        await manager.save({
          status: 'interrupted',
          phase: 'cleanup',
          finishedAt: Date.now(),
          error: 'interrupted',
        });
    }
    return manager;
  }
  private save(change: Partial<ProbeJob>): Promise<void> {
    this.current = jobSchema.parse({ ...this.current, ...change });
    const bytes = Buffer.from(JSON.stringify(this.current));
    const write = this.writes.then(async () => {
      await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
      await writeDurable(join(this.deps.root, 'probe-job'), bytes, false);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
  status(id?: string): ProbeJob | null {
    if (!this.current || (id && this.current.id !== id)) return null;
    return structuredClone(this.current);
  }
  start(recoveryKey: string): Promise<ProbeJob> {
    let accept!: (job: ProbeJob) => void;
    let reject!: (error: unknown) => void;
    const accepted = new Promise<ProbeJob>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    const operation = this.deps.exclusive(async () => {
      if (this.current) await this.deps.cleanup(this.current);
      const controller = new AbortController();
      this.controller = controller;
      this.committing = false;
      this.current = {
        format: 1,
        installationId: this.deps.installationId,
        id: randomUUID(),
        status: 'running',
        phase: 'selecting',
        startedAt: Date.now(),
        finishedAt: null,
        snapshot: null,
        error: null,
      };
      let timedOut = false;
      const timeout = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
        },
        this.deps.timeoutMs ?? 6 * 60 * 60 * 1000,
      );
      timeout.unref();
      let cleanupFailed = false;
      try {
        await this.save({});
        accept(this.status()!);
        let result: BackupProbeResult | undefined;
        let failed = false;
        try {
          result = await this.deps.execute(
            this.status()!,
            recoveryKey,
            controller.signal,
            (phase) => this.save({ phase }),
            (repository, sequence) => this.save({ snapshot: { repository, sequence } }),
          );
        } catch {
          failed = true;
        }
        recoveryKey = '';
        try {
          await this.save({ phase: 'cleanup' });
        } catch {
          failed = true;
        }
        try {
          await this.deps.cleanup(this.current);
        } catch {
          cleanupFailed = true;
        }
        if (failed || cleanupFailed || !result) throw new Error('Backup probe failed');
        controller.signal.throwIfAborted();
        // Cancellation ends before this atomic success commit; cleanup is already complete.
        this.committing = true;
        clearTimeout(timeout);
        await this.deps.verified(result);
        await this.save({ status: 'succeeded', finishedAt: Date.now(), error: null });
      } catch {
        reject(new Error('Backup probe could not start'));
        await this.save({
          status:
            cleanupFailed || timedOut
              ? 'failed'
              : controller.signal.aborted
                ? 'cancelled'
                : 'failed',
          finishedAt: Date.now(),
          error: cleanupFailed
            ? 'cleanup-failed'
            : timedOut
              ? 'timed-out'
              : controller.signal.aborted
                ? null
                : 'probe-failed',
        });
      } finally {
        clearTimeout(timeout);
        recoveryKey = '';
        this.controller = undefined;
        this.committing = false;
      }
    });
    void operation
      .catch(() => reject(new Error('Backup operation unavailable')))
      .finally(() => {
        recoveryKey = '';
      });
    return accepted;
  }
  async cancel(id: string): Promise<ProbeJob> {
    if (!this.current || this.current.id !== id) throw new Error('Unknown backup probe');
    if (
      !this.controller ||
      this.committing ||
      !['running', 'cancelling'].includes(this.current.status)
    )
      return this.status()!;
    this.controller.abort();
    await this.save({ status: 'cancelling' });
    return this.status()!;
  }
  abort(): void {
    if (!this.committing) this.controller?.abort();
  }
}

export function probeVerificationAlerts(
  confirmedAt: number,
  lastProbe: { finishedAt: number } | null,
  now: number,
): string[] {
  return now - (lastProbe?.finishedAt ?? confirmedAt) >= 90 * 24 * 60 * 60 * 1000
    ? ['probe-overdue']
    : [];
}
