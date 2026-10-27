import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readBounded, writeDurable } from './repository.js';
import { withRepositoryLock } from './repository-lock.js';
import { validateScheduleState } from './scheduler.js';

const encoded = z
  .string()
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/);
const time = z.number().int().nonnegative().nullable();
const schema = z
  .object({
    format: z.literal(1),
    installationId: z.string().uuid(),
    targetId: z.string().uuid(),
    keyGeneration: z.number().int().min(1).max(999999999),
    repositoryNumber: z.number().int().min(1).max(999999999),
    confirmedAt: z.number().int().nonnegative(),
    host: z
      .object({
        recipient: z.string().regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/),
        signingKey: encoded,
        verificationKey: encoded,
        fingerprintKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      })
      .strict(),
    schedule: z
      .object({
        intervalMs: z.number().int(),
        paused: z.boolean(),
        lastSuccess: time,
        lastAttempt: time,
        failures: z.number().int().nonnegative(),
      })
      .strict(),
    lastProbe: z
      .object({
        repository: z.string().max(128),
        sequence: z.number().int().positive(),
        finishedAt: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type BackupState = z.infer<typeof schema>;

function validateState(value: unknown, installationId: string): BackupState {
  const state = schema.parse(value);
  if (state.installationId !== installationId)
    throw new Error('Backup state belongs to another installation');
  validateScheduleState(state.schedule);
  const signingKey = createPrivateKey({
    key: Buffer.from(state.host.signingKey, 'base64url'),
    type: 'pkcs8',
    format: 'der',
  });
  const publicKey = createPublicKey(signingKey);
  if (
    signingKey.asymmetricKeyType !== 'ed25519' ||
    publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') !==
      state.host.verificationKey
  )
    throw new Error('Invalid host backup signing identity');
  if (
    state.lastProbe?.repository !== undefined &&
    !state.lastProbe.repository.startsWith(state.installationId + '-r')
  )
    throw new Error('Probe state belongs to another installation');
  return state;
}

/** A private, atomic document outside snapshot scopes. It never contains a recovery/decryption key. */
export class BackupStateStore {
  constructor(
    readonly root: string,
    readonly installationId: string,
  ) {
    z.string().uuid().parse(installationId);
  }
  async load(): Promise<BackupState | undefined> {
    try {
      return validateState(
        JSON.parse((await readBounded(join(this.root, 'state'), 64 * 1024)).toString('utf8')),
        this.installationId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Backup state is invalid; setup and writes are disabled', { cause: error });
    }
  }
  async create(state: BackupState): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await withRepositoryLock(join(this.root, 'state.lock'), async () => {
      const checked = validateState(state, this.installationId);
      await writeDurable(join(this.root, 'state'), Buffer.from(JSON.stringify(checked)), true);
    });
  }
  async update(change: (current: BackupState) => BackupState): Promise<BackupState> {
    return withRepositoryLock(join(this.root, 'state.lock'), async () => {
      const current = await this.load();
      if (!current) throw new Error('Backups are not configured');
      const next = validateState(change(structuredClone(current)), this.installationId);
      if (
        next.targetId !== current.targetId ||
        next.repositoryNumber !== current.repositoryNumber ||
        next.keyGeneration !== current.keyGeneration ||
        JSON.stringify(next.host) !== JSON.stringify(current.host)
      )
        throw new Error('Backup identity changes require a new repository');
      await writeDurable(join(this.root, 'state'), Buffer.from(JSON.stringify(next)), false);
      return next;
    });
  }
}
