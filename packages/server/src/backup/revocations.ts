import { randomUUID } from 'node:crypto';
import { mkdir, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type BackupHostKeys, openMetadata, sealMetadata } from './crypto.js';
import type { BackupDestination } from './destination.js';
import { decodeLocalIndex, encodeLocalIndex } from './local-state.js';
import { readBounded, writeDurable } from './repository.js';
import { withRepositoryLock } from './repository-lock.js';
import { openBackupPath } from './git.js';
const deviceId = z.string().min(1).max(256);
const entrySchema = z
  .object({
    kind: z.literal('revocation'),
    installationId: z.string().uuid(),
    keyGeneration: z.number().int().min(1).max(999999999),
    sequence: z.number().int().min(1).safe(),
    deviceId,
    revokedAt: z.string().datetime({ offset: true }),
    eventId: z.string().uuid(),
  })
  .strict();
const checkpointSchema = z
  .object({
    kind: z.literal('revocation-checkpoint'),
    installationId: z.string().uuid(),
    keyGeneration: z.number().int().min(1).max(999999999),
    lowWater: z.number().int().min(1).safe(),
    highWater: z.number().int().min(0).safe(),
  })
  .strict();
const queuedSchema = z
  .object({
    deviceId,
    revokedAt: z.string().datetime({ offset: true }),
    eventId: z.string().uuid(),
  })
  .strict();
async function names(path: string, limit: number): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of await opendir(path)) {
    if (result.length >= limit) throw new Error('Revocation journal entry count exceeds limit');
    result.push(entry.name);
  }
  return result;
}

/** Queue before deleting a token. Destination failure never loses a successfully queued revocation. */
export class BackupRevocationJournal {
  private readonly root: string;
  private readonly outbox: string;
  constructor(
    private readonly destination: BackupDestination,
    private readonly stateRoot: string,
    private readonly installationId: string,
    private readonly keyGeneration: number,
    private readonly host: BackupHostKeys,
  ) {
    z.string().uuid().parse(installationId);
    z.number().int().min(1).max(999999999).parse(keyGeneration);
    this.root = destination.pinnedPath('revocations', `${installationId}-k${keyGeneration}`);
    this.outbox = join(stateRoot, 'revocation-outbox');
  }
  async queue(id: string, event?: { eventId: string; revokedAt: string }): Promise<boolean> {
    deviceId.parse(id);
    await mkdir(this.outbox, { recursive: true, mode: 0o700 });
    const record = queuedSchema.parse({
      deviceId: id,
      revokedAt: event?.revokedAt ?? new Date().toISOString(),
      eventId: event?.eventId ?? randomUUID(),
    });
    try {
      await writeDurable(
        join(this.outbox, record.eventId),
        encodeLocalIndex(record, this.host.fingerprintKey),
        true,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = queuedSchema.parse(
        decodeLocalIndex(
          await readBounded(join(this.outbox, record.eventId), 4096),
          this.host.fingerprintKey,
        ),
      );
      if (
        existing.deviceId !== record.deviceId ||
        existing.revokedAt !== record.revokedAt ||
        existing.eventId !== record.eventId
      )
        throw new Error('Revocation outbox identity mismatch', { cause: error });
    }
    try {
      await this.flush();
      return true;
    } catch {
      return false;
    }
  }
  async flush(): Promise<void> {
    await mkdir(this.outbox, { recursive: true, mode: 0o700 });
    await withRepositoryLock(join(this.stateRoot, 'revocation-outbox.lock'), async () => {
      const pending = await names(this.outbox, 100000);
      if (!pending.length) return;
      await this.destination.assertWritable();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await withRepositoryLock(join(this.root, 'lock'), async () => {
        let sequence = 0;
        for await (const { name } of await opendir(this.root)) {
          if (/^[1-9][0-9]*$/.test(name)) {
            const number = Number(name);
            if (!Number.isSafeInteger(number)) throw new Error('Invalid revocation sequence');
            sequence = Math.max(sequence, number);
          } else if (
            name !== 'lock' &&
            name !== 'checkpoint' &&
            name !== 'sequence' &&
            !name.startsWith('.pending-')
          )
            throw new Error('Unexpected revocation journal entry');
        }
        try {
          const reserved = (await readBounded(join(this.root, 'sequence'), 32)).toString();
          if (!/^(0|[1-9][0-9]*)$/.test(reserved) || !Number.isSafeInteger(Number(reserved)))
            throw new Error('Invalid revocation sequence');
          sequence = Math.max(sequence, Number(reserved));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        for (const event of pending) {
          if (!/^[0-9a-f-]{36}$/.test(event)) throw new Error('Unexpected revocation outbox entry');
          const queued = queuedSchema.parse(
            decodeLocalIndex(
              await readBounded(join(this.outbox, event), 4096),
              this.host.fingerprintKey,
            ),
          );
          if (queued.eventId !== event || !Number.isSafeInteger(sequence + 1))
            throw new Error('Invalid queued revocation');
          sequence++;
          await this.destination.assertWritable();
          await writeDurable(join(this.root, 'sequence'), Buffer.from(String(sequence)), false);
          const entry = {
            kind: 'revocation' as const,
            installationId: this.installationId,
            keyGeneration: this.keyGeneration,
            sequence,
            ...queued,
          };
          await writeDurable(
            join(this.root, String(sequence)),
            await sealMetadata(this.host, Buffer.from(JSON.stringify(entry))),
            true,
          );
          await writeDurable(
            join(this.root, 'checkpoint'),
            await sealMetadata(
              this.host,
              Buffer.from(
                JSON.stringify({
                  kind: 'revocation-checkpoint',
                  installationId: this.installationId,
                  keyGeneration: this.keyGeneration,
                  lowWater: 1,
                  highWater: sequence,
                }),
              ),
            ),
            false,
          );
          await rm(join(this.outbox, event));
        }
      });
    });
  }
}

/** Missing/unreadable generations are reported; mandatory review still blocks every restored device. */
export async function readRevocations(
  backupRoot: string,
  recoveryKey: string,
  signal?: AbortSignal,
  deviceIds?: ReadonlySet<string>,
): Promise<{ revokedIds: Set<string>; findings: string[] }> {
  let pinned;
  try {
    pinned = await openBackupPath(backupRoot, 'revocations', true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { revokedIds: new Set(), findings: ['revocation-journal-missing'] };
    throw error;
  }
  try {
    return await readPinnedRevocations(
      `/proc/self/fd/${pinned.fd}/.`,
      recoveryKey,
      signal,
      deviceIds,
    );
  } finally {
    await pinned.close();
  }
}

async function readPinnedRevocations(
  root: string,
  recoveryKey: string,
  signal?: AbortSignal,
  deviceIds?: ReadonlySet<string>,
): Promise<{ revokedIds: Set<string>; findings: string[] }> {
  const generations = await names(root, 10000);
  const revokedIds = new Set<string>();
  const findings: string[] = [];
  const addFinding = (finding: string) => {
    if (findings.length < 9999) findings.push(finding);
    else if (findings.length === 9999) findings.push('revocation-findings-truncated');
  };
  for (const generation of generations) {
    signal?.throwIfAborted();
    const match = /^([0-9a-f-]{36})-k([1-9][0-9]{0,8})$/.exec(generation);
    if (!match) throw new Error('Invalid revocation journal generation');
    const installationId = match[1]!;
    const keyGeneration = Number(match[2]);
    const pinned = await openBackupPath(root, generation, true);
    try {
      const directory = `/proc/self/fd/${pinned.fd}/.`;
      let checkpoint: z.infer<typeof checkpointSchema> | undefined;
      try {
        checkpoint = checkpointSchema.parse(
          JSON.parse(
            (
              await openMetadata(
                recoveryKey,
                await readBounded(join(directory, 'checkpoint'), 8192),
                signal,
              )
            ).toString(),
          ),
        );
        if (
          checkpoint.installationId !== installationId ||
          checkpoint.keyGeneration !== keyGeneration ||
          checkpoint.lowWater > checkpoint.highWater + 1
        )
          throw new Error();
      } catch {
        addFinding(`${generation}: checkpoint-unreadable`);
      }
      signal?.throwIfAborted();
      let covered = 0;
      for await (const { name } of await opendir(directory)) {
        signal?.throwIfAborted();
        if (
          name === 'checkpoint' ||
          name === 'lock' ||
          name === 'sequence' ||
          name.startsWith('.pending-')
        )
          continue;
        if (!/^[1-9][0-9]*$/.test(name) || !Number.isSafeInteger(Number(name)))
          throw new Error('Invalid revocation entry name');
        const sequence = Number(name);
        if (checkpoint && sequence >= checkpoint.lowWater && sequence <= checkpoint.highWater)
          covered++;
        try {
          const entry = entrySchema.parse(
            JSON.parse(
              (
                await openMetadata(
                  recoveryKey,
                  await readBounded(join(directory, name), 8192),
                  signal,
                )
              ).toString(),
            ),
          );
          if (
            entry.installationId !== installationId ||
            entry.keyGeneration !== keyGeneration ||
            entry.sequence !== sequence
          )
            throw new Error();
          if (!deviceIds || deviceIds.has(entry.deviceId)) revokedIds.add(entry.deviceId);
        } catch {
          addFinding(`${generation}/${name}: entry-unreadable`);
        }
      }
      signal?.throwIfAborted();
      if (checkpoint) {
        if (covered !== checkpoint.highWater - checkpoint.lowWater + 1)
          addFinding(`${generation}: sequence-gap`);
      }
      // A crash after reserving the last sequence must remain visible even when
      // its entry and checkpoint were never committed. This counter is advisory:
      // it can add a warning, never establish that a revocation was applied.
      try {
        const reserved = (await readBounded(join(directory, 'sequence'), 32)).toString();
        if (!/^(0|[1-9][0-9]*)$/.test(reserved) || !Number.isSafeInteger(Number(reserved)))
          throw new Error();
        if (Number(reserved) > (checkpoint?.highWater ?? 0))
          addFinding(`${generation}: reserved-sequence-gap`);
      } catch {
        addFinding(`${generation}: sequence-counter-unreadable`);
      }
    } finally {
      await pinned.close();
    }
  }
  signal?.throwIfAborted();
  return { revokedIds, findings };
}

export interface BackupRevocationOutboxStore {
  listBackupRevocations(): Promise<{ id: string; deviceId: string; revokedAt: string }[]>;
  acknowledgeBackupRevocation(id: string): Promise<void>;
}

/** Keep DB outbox rows in snapshots until their signed destination entries are durable. */
export async function syncRevocationOutbox(
  store: BackupRevocationOutboxStore,
  journal: Pick<BackupRevocationJournal, 'queue'>,
  signal?: AbortSignal,
): Promise<void> {
  // Bound each drain so a continuously growing outbox cannot monopolize the scheduler.
  // The next tick resumes any remaining rows; acknowledgements follow durable publication.
  for (let batch = 0; batch < 16; batch++) {
    signal?.throwIfAborted();
    const events = await store.listBackupRevocations();
    if (events.length === 0) return;
    for (const event of events) {
      signal?.throwIfAborted();
      if (!(await journal.queue(event.deviceId, { eventId: event.id, revokedAt: event.revokedAt })))
        throw new Error('Backup revocation destination unavailable; queued records retained');
      await store.acknowledgeBackupRevocation(event.id);
    }
  }
}
