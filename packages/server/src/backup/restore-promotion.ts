import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RestoreJob } from './restore-job.js';
import { readBounded, writeDurable } from './repository.js';
import { withRepositoryLock } from './repository-lock.js';

const previous = z
  .object({
    containers: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{64}$/),
            name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/),
            running: z.boolean(),
            restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']),
            maximumRetryCount: z.number().int().nonnegative().safe(),
          })
          .strict(),
      )
      .max(10000),
    dataVolume: z.boolean(),
    databaseVolume: z.boolean(),
    managedVolume: z.boolean(),
    hostConfiguration: z.boolean(),
  })
  .strict();
const phase = z.enum([
  'described',
  'stopping',
  'stopped',
  'saving',
  'saved',
  'publishing',
  'published',
  'starting',
  'started',
  'checking',
  'healthy',
  'rolling-back',
  'rolled-back',
]);
const schema = z
  .object({
    format: z.literal(1),
    jobId: z.string().uuid(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    previous,
    phase,
    rollbackFrom: phase.nullable(),
  })
  .strict();
export type RestorePreviousInstallation = z.infer<typeof previous>;
export function parseRestorePreviousInstallation(input: unknown): RestorePreviousInstallation {
  return previous.parse(input);
}
export interface RestorePromotionAdapters {
  /** Inventory only. Container IDs and volume presence are frozen before stopping any writer. */
  inspect(this: void): Promise<RestorePreviousInstallation>;
  stop(this: void, previous: RestorePreviousInstallation, signal?: AbortSignal): Promise<void>;
  /** Cold copies and host files are retained until explicit disposal after successful acceptance. */
  save(this: void, previous: RestorePreviousInstallation, signal?: AbortSignal): Promise<void>;
  publish(this: void, signal?: AbortSignal): Promise<void>;
  start(this: void, signal?: AbortSignal): Promise<void>;
  healthy(this: void, signal?: AbortSignal): Promise<void>;
  /** Never infer whether publication happened from currently running containers. */
  rollback(
    this: void,
    previous: RestorePreviousInstallation,
    from: z.infer<typeof phase>,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Every effect is preceded by durable intent. Drivers retry by job ID using immutable saved sources. */
export class InstallerRestorePromotion {
  constructor(
    private readonly root: string,
    private readonly adapters: RestorePromotionAdapters,
  ) {}
  private async load(job: RestoreJob): Promise<z.infer<typeof schema> | undefined> {
    try {
      const record = schema.parse(
        JSON.parse((await readBounded(join(this.root, 'promotion'), 2 * 1024 * 1024)).toString()),
      );
      if (record.jobId !== job.id || record.manifestHash !== job.verified?.manifestHash)
        throw new Error('Promotion ownership mismatch');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async status(job: RestoreJob): Promise<z.infer<typeof phase> | null> {
    return (await this.load(job))?.phase ?? null;
  }
  async run(job: RestoreJob, signal?: AbortSignal): Promise<void> {
    if (!job.verified || !['reviewed', 'promoting'].includes(job.phase))
      throw new Error('Verified, reviewed restore required for promotion');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await withRepositoryLock(join(this.root, 'promotion.lock'), async () => {
      let state = await this.load(job);
      const save = async (next: z.infer<typeof phase>) => {
        state = schema.parse({ ...state, phase: next });
        await writeDurable(join(this.root, 'promotion'), Buffer.from(JSON.stringify(state)), false);
      };
      if (!state) {
        signal?.throwIfAborted();
        state = schema.parse({
          format: 1,
          jobId: job.id,
          manifestHash: job.verified!.manifestHash,
          previous: await this.adapters.inspect(),
          phase: 'described',
          rollbackFrom: null,
        });
        await writeDurable(join(this.root, 'promotion'), Buffer.from(JSON.stringify(state)), true);
      }
      const transition = async (
        pending: z.infer<typeof phase>,
        complete: z.infer<typeof phase>,
        effect: () => Promise<void>,
      ) => {
        signal?.throwIfAborted();
        await save(pending);
        await effect();
        signal?.throwIfAborted();
        await save(complete);
      };
      for (;;) {
        switch (state.phase) {
          case 'described':
          case 'stopping':
            await transition('stopping', 'stopped', () =>
              this.adapters.stop(state!.previous, signal),
            );
            break;
          case 'stopped':
          case 'saving':
            await transition('saving', 'saved', () => this.adapters.save(state!.previous, signal));
            break;
          case 'saved':
          case 'publishing':
            await transition('publishing', 'published', () => this.adapters.publish(signal));
            break;
          case 'published':
          case 'starting':
            await transition('starting', 'started', () => this.adapters.start(signal));
            break;
          case 'started':
          case 'checking':
            await transition('checking', 'healthy', () => this.adapters.healthy(signal));
            break;
          case 'healthy':
            return;
          default:
            throw new Error('Rolled-back promotion cannot be resumed');
        }
      }
    });
  }
  async rollback(job: RestoreJob, signal?: AbortSignal): Promise<void> {
    if (job.phase === 'accepted' || job.phase === 'accepting')
      throw new Error('Acceptance requires explicit installation recovery');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await withRepositoryLock(join(this.root, 'promotion.lock'), async () => {
      const state = await this.load(job);
      if (!state || state.phase === 'rolled-back') return;
      const from = state.rollbackFrom ?? state.phase;
      const pending = schema.parse({ ...state, phase: 'rolling-back', rollbackFrom: from });
      await writeDurable(join(this.root, 'promotion'), Buffer.from(JSON.stringify(pending)), false);
      signal?.throwIfAborted();
      await this.adapters.rollback(state.previous, from, signal);
      signal?.throwIfAborted();
      await writeDurable(
        join(this.root, 'promotion'),
        Buffer.from(JSON.stringify({ ...pending, phase: 'rolled-back' })),
        false,
      );
    });
  }
}
