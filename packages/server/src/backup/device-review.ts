import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readBounded, writeDurable } from './repository.js';
import { withRepositoryLock } from './repository-lock.js';
const id = z.string().min(1).max(256);
const schema = z
  .object({
    kind: z.literal('backup-device-review'),
    status: z.enum(['pending', 'complete']),
    sessionHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    expiresAt: z.number().int().nonnegative(),
    devices: z.array(id).max(10000),
    revokedIds: z.array(id).max(100000),
    findings: z.array(z.string().max(4096)).max(10000),
    keptIds: z.array(id).max(10000),
  })
  .strict();
export type BackupDeviceReviewState = z.infer<typeof schema>;
const hash = (token: string): Buffer =>
  createHash('sha256').update('verity-backup-review-v1\0').update(token).digest();

/** Host-only, outside snapshots. A recovery session never becomes an ordinary device credential. */
export class BackupDeviceReview {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}
  async create(
    devices: string[],
    revokedIds: Iterable<string>,
    findings: string[],
  ): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return withRepositoryLock(join(this.root, 'review.lock'), async () => {
      if ((await this.load())?.status === 'complete')
        throw new Error('Device review already complete');
      const token = randomBytes(32).toString('base64url');
      const state = schema.parse({
        kind: 'backup-device-review',
        status: 'pending',
        sessionHash: hash(token).toString('hex'),
        expiresAt: this.now() + 60 * 60 * 1000,
        devices: [...new Set(devices)],
        revokedIds: [...new Set(revokedIds)],
        findings,
        keptIds: [],
      });
      const encoded = Buffer.from(JSON.stringify(state));
      if (encoded.length > 8 * 1024 * 1024)
        throw new Error('Device review exceeds readable size limit');
      await writeDurable(join(this.root, 'device-review'), encoded, false);
      return token;
    });
  }
  async load(): Promise<BackupDeviceReviewState | undefined> {
    try {
      return schema.parse(
        JSON.parse(
          (await readBounded(join(this.root, 'device-review'), 8 * 1024 * 1024)).toString(),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Recovery review state invalid; device access remains blocked', {
        cause: error,
      });
    }
  }
  private authorize(
    state: BackupDeviceReviewState | undefined,
    token: string,
  ): asserts state is BackupDeviceReviewState {
    if (
      !state ||
      state.status !== 'pending' ||
      state.sessionHash === null ||
      this.now() >= state.expiresAt ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !timingSafeEqual(hash(token), Buffer.from(state.sessionHash, 'hex'))
    )
      throw new Error('Invalid or expired recovery review session');
  }
  async inspect(
    token: string,
  ): Promise<Pick<BackupDeviceReviewState, 'devices' | 'revokedIds' | 'findings'>> {
    const state = await this.load();
    this.authorize(state, token);
    return { devices: state.devices, revokedIds: state.revokedIds, findings: state.findings };
  }
  async accept(
    token: string,
    keepIds: readonly string[],
    removeOtherTokens: (allowedIds: readonly string[]) => Promise<void>,
  ): Promise<void> {
    await withRepositoryLock(join(this.root, 'review.lock'), async () => {
      const state = await this.load();
      this.authorize(state, token);
      const kept = [...new Set(keepIds)];
      if (
        kept.some((device) => !state.devices.includes(device) || state.revokedIds.includes(device))
      )
        throw new Error('Cannot keep an unknown or journal-revoked device');
      const complete: BackupDeviceReviewState = {
        ...state,
        status: 'complete',
        keptIds: kept,
        sessionHash: null,
      };
      const encoded = Buffer.from(JSON.stringify(complete));
      if (encoded.length > 8 * 1024 * 1024)
        throw new Error('Device review exceeds readable size limit');
      // Delete first, consume the review second. A crash between them keeps ALL credentials blocked.
      await removeOtherTokens(kept);
      await writeDurable(join(this.root, 'device-review'), encoded, false);
    });
  }
  async blocksDevices(): Promise<boolean> {
    return (await this.load())?.status !== 'complete';
  }
}
