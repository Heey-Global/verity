import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import { readBounded, writeDurable } from './repository.js';
import { withRepositoryLock } from './repository-lock.js';

const absolute = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      isAbsolute(value) && normalize(value) === value && value !== '/' && !/[\0\r\n,:]/.test(value),
  );
const image = z
  .string()
  .regex(/^ghcr\.io\/heey-global\/verity\/verity-server(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/);
const selection = z
  .object({
    source: absolute,
    repository: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-r[1-9][0-9]{0,8}$/),
    sequence: z.number().int().positive().safe(),
    kind: z.enum(['manual', 'scheduled', 'pre-update']),
    newIdentity: z.boolean(),
  })
  .strict();
const verified = z
  .object({
    image,
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    schema: z.string().min(1).max(256),
    architecture: z.enum(['amd64', 'arm64']),
    deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    sourceInstallationId: z.string().uuid(),
  })
  .strict();
const phase = z.enum([
  'verifying',
  'verified',
  'staging',
  'staged',
  'starting-trial',
  'trial',
  'reviewing',
  'reviewed',
  'promoting',
  'promoted',
  'accepting',
  'accepted',
  'aborting',
  'aborted',
]);
const record = z
  .object({
    format: z.literal(1),
    id: z.string().uuid(),
    installationId: z.string().uuid(),
    selection,
    verified: verified.nullable(),
    phase,
    startedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) =>
      value.verified !== null || ['verifying', 'aborting', 'aborted'].includes(value.phase),
    'Verified restore metadata required',
  );
export type RestoreJob = z.infer<typeof record>;
export type RestoreSelection = z.infer<typeof selection>;
export interface RestoreJobAdapters {
  /** Authenticate the entire snapshot and signed release before creating any live resource. */
  verify(
    this: void,
    job: RestoreJob,
    recoveryKey: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof verified>>;
  /** Each operation must be idempotent by job ID, including a retry after an ambiguous process exit. */
  stage(this: void, job: RestoreJob, recoveryKey: string, signal?: AbortSignal): Promise<void>;
  trial(this: void, job: RestoreJob, signal?: AbortSignal): Promise<void>;
  review(this: void, job: RestoreJob, signal?: AbortSignal): Promise<void>;
  /** Recheck the reviewed allowlist and revocation journal immediately before promotion. */
  promote(this: void, job: RestoreJob, signal?: AbortSignal): Promise<void>;
  /** Publish backup identity only after successful promotion/startup, before enabling background work. */
  accept(this: void, job: RestoreJob, signal?: AbortSignal): Promise<void>;
  /** Runs only after durable acceptance; failures remain retryable without repeating promotion. */
  initialize(this: void, job: RestoreJob, recoveryKey: string, signal?: AbortSignal): Promise<void>;
  abort(this: void, job: RestoreJob, signal?: AbortSignal): Promise<void>;
}

/** Persistent checkpoints contain authority and progress, never credentials or recovery secrets. */
export class InstallerRestoreJob {
  constructor(
    private readonly root: string,
    private readonly adapters: RestoreJobAdapters,
  ) {}

  private async locked<T>(action: (pinned: string) => Promise<T>): Promise<T> {
    absolute.parse(this.root);
    await mkdir(this.root, { mode: 0o700, recursive: true });
    const directory = await open(
      this.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await directory.stat();
      if (
        (await realpath(this.root)) !== this.root ||
        info.uid !== process.geteuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw new Error('Restore state requires a private installer-owned directory');
      const pinned = `/proc/self/fd/${directory.fd}/.`;
      const lock = await open(
        join(pinned, 'lock'),
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      try {
        const metadata = await lock.stat();
        if (
          !metadata.isFile() ||
          metadata.nlink !== 1 ||
          metadata.uid !== info.uid ||
          (metadata.mode & 0o077) !== 0
        )
          throw new Error('Invalid restore lock');
        return await withRepositoryLock(`/proc/${process.pid}/fd/${lock.fd}`, () => action(pinned));
      } finally {
        await lock.close();
      }
    } finally {
      await directory.close();
    }
  }
  private async read(pinned: string): Promise<RestoreJob | null> {
    try {
      return record.parse(JSON.parse((await readBounded(join(pinned, 'job'), 16384)).toString()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Invalid restore checkpoint; explicit recovery is required', {
        cause: error,
      });
    }
  }
  async status(): Promise<RestoreJob | null> {
    return this.locked((root) => this.read(root));
  }
  async begin(input: RestoreSelection): Promise<RestoreJob> {
    const checked = selection.parse(input);
    return this.locked(async (root) => {
      const previous = await this.read(root);
      if (previous && previous.phase !== 'aborted') {
        if (previous.phase !== 'accepted') throw new Error('A restore checkpoint already exists');
        try {
          if (
            (await readBounded(join(root, 'activation-complete'), 128)).toString().trim() !==
            previous.id
          )
            throw new Error('Restore activation checkpoint mismatch');
        } catch (error) {
          throw new Error(
            'A restore checkpoint already exists; finish activation before starting another',
            { cause: error },
          );
        }
      }
      if (previous) {
        const archive = join(root, previous.phase + '-' + previous.id);
        const bytes = Buffer.from(JSON.stringify(previous));
        try {
          await writeDurable(archive, bytes, true);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (!(await readBounded(archive, 16384)).equals(bytes))
            throw new Error('Restore archive mismatch', { cause: error });
        }
      }
      const now = Date.now();
      const job: RestoreJob = {
        format: 1,
        id: randomUUID(),
        installationId: randomUUID(),
        selection: checked,
        verified: null,
        phase: 'verifying',
        startedAt: now,
        updatedAt: now,
      };
      await writeDurable(join(root, 'job'), Buffer.from(JSON.stringify(job)), previous === null);
      return job;
    });
  }
  /** Explicit calls resume a pending phase; startup/status alone never resumes destructive work. */
  async advance(id: string, recoveryKey: string, signal?: AbortSignal): Promise<RestoreJob> {
    z.string().uuid().parse(id);
    return this.locked(async (root) => {
      let job = await this.read(root);
      if (!job || job.id !== id) throw new Error('Restore job not found');
      const save = async (next: RestoreJob['phase'], metadata = job!.verified) => {
        job = record.parse({ ...job, phase: next, verified: metadata, updatedAt: Date.now() });
        await writeDurable(join(root, 'job'), Buffer.from(JSON.stringify(job)), false);
      };
      const run = async (
        pending: RestoreJob['phase'],
        complete: RestoreJob['phase'],
        operation: (current: RestoreJob) => Promise<void>,
      ) => {
        signal?.throwIfAborted();
        if (job!.phase !== pending) await save(pending);
        await operation(structuredClone(job!));
        signal?.throwIfAborted();
        await save(complete);
      };
      signal?.throwIfAborted();
      switch (job.phase) {
        case 'verifying':
          if (!recoveryKey) throw new Error('Recovery key required to verify the snapshot');
          await save(
            'verified',
            verified.parse(await this.adapters.verify(structuredClone(job), recoveryKey, signal)),
          );
          break;
        case 'verified':
        case 'staging':
          if (!recoveryKey) throw new Error('Recovery key required to stage the snapshot');
          await run('staging', 'staged', (current) =>
            this.adapters.stage(current, recoveryKey, signal),
          );
          break;
        case 'staged':
        case 'starting-trial':
          await run('starting-trial', 'trial', (current) => this.adapters.trial(current, signal));
          break;
        case 'trial':
        case 'reviewing':
          await run('reviewing', 'reviewed', (current) => this.adapters.review(current, signal));
          break;
        case 'reviewed':
        case 'promoting':
          await run('promoting', 'promoted', (current) => this.adapters.promote(current, signal));
          break;
        case 'promoted':
        case 'accepting':
          await run('accepting', 'accepted', (current) => this.adapters.accept(current, signal));
          break;
        case 'accepted':
          break;
        default:
          throw new Error('Aborted restore cannot be advanced');
      }
      if (job.phase === 'accepted') {
        if (!recoveryKey) throw new Error('Recovery key required to initialize accepted backups');
        await this.adapters.initialize(structuredClone(job), recoveryKey, signal);
      }
      return structuredClone(job);
    });
  }
  async abort(id: string, signal?: AbortSignal): Promise<RestoreJob> {
    return this.locked(async (root) => {
      const job = await this.read(root);
      if (!job || job.id !== id) throw new Error('Restore job not found');
      if (job.phase === 'accepted')
        throw new Error('Accepted restore requires explicit recovery, not staging deletion');
      if (job.phase === 'aborted') return job;
      const pending = record.parse({ ...job, phase: 'aborting', updatedAt: Date.now() });
      await writeDurable(join(root, 'job'), Buffer.from(JSON.stringify(pending)), false);
      await this.adapters.abort(structuredClone(pending), signal);
      const completed = record.parse({ ...pending, phase: 'aborted', updatedAt: Date.now() });
      await writeDurable(join(root, 'job'), Buffer.from(JSON.stringify(completed)), false);
      return completed;
    });
  }
}
