import { join } from 'node:path';
import { z } from 'zod';
import { readBounded, writeDurable } from './repository.js';
import { validateBackupState, type BackupState, type BackupStateStore } from './state.js';

export type ReplacementReason = 'lost' | 'exposed';
const journalSchema = z
  .object({
    format: z.literal(1),
    id: z.string().uuid(),
    reason: z.enum(['lost', 'exposed']),
    previous: z.unknown(),
    next: z.unknown(),
    complete: z.boolean(),
  })
  .strict();
export interface ReplacementJournal {
  format: 1;
  id: string;
  reason: ReplacementReason;
  previous: BackupState;
  next: BackupState;
  complete: boolean;
}

/** A confirmed intent contains only host encryption recipients and signing material, never a recovery key. */
export class BackupKeyReplacement {
  constructor(private readonly state: BackupStateStore) {}
  async load(): Promise<ReplacementJournal | undefined> {
    try {
      const value = journalSchema.parse(
        JSON.parse(
          (await readBounded(join(this.state.root, 'key-replacement'), 160 * 1024)).toString(),
        ),
      );
      const previous = validateBackupState(value.previous, this.state.installationId);
      const next = validateBackupState(value.next, this.state.installationId);
      if (
        next.keyGeneration <= previous.keyGeneration ||
        next.repositoryNumber <= previous.repositoryNumber ||
        next.targetId !== previous.targetId ||
        next.host.recipient === previous.host.recipient
      )
        throw new Error('Invalid replacement generation');
      return { ...value, previous, next };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async save(journal: ReplacementJournal): Promise<void> {
    await writeDurable(
      join(this.state.root, 'key-replacement'),
      Buffer.from(JSON.stringify(journal)),
      false,
    );
  }
  async resume(actions: {
    retire: (journal: ReplacementJournal) => Promise<void>;
    publish: (state: BackupState) => Promise<void>;
  }): Promise<void> {
    const journal = await this.load();
    if (!journal || journal.complete) return;
    // Exposure retirement precedes every publication attempt, including after restart.
    if (journal.reason === 'exposed') await actions.retire(journal);
    await actions.publish(journal.next);
    await this.state.replace(journal.previous, journal.next);
    await this.save({ ...journal, complete: true });
  }
}
