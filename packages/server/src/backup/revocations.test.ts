import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { generateBackupKeys } from './crypto.js';
import { BackupDestination } from './destination.js';
import { BackupRevocationJournal, readRevocations } from './revocations.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('durable device revocation journal', () => {
  it('queues during an unavailable destination, retries, and detects deleted or replayed signed entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-revocations-'));
    roots.push(root);
    const target = join(root, 'backup');
    const state = join(root, 'state');
    await mkdir(target);
    await mkdir(state);
    const targetId = randomUUID();
    await writeFile(join(target, '.verity-backup-target'), targetId);
    const destination = await BackupDestination.open(target, targetId);
    const { host, recoveryKey } = await generateBackupKeys();
    const installationId = randomUUID();
    const journal = new BackupRevocationJournal(destination, state, installationId, 1, host);
    try {
      await rename(join(target, '.verity-backup-target'), join(target, 'marker-offline'));
      await journal.queue('revoked-while-paused');
      expect(await readdir(join(state, 'revocation-outbox'))).toHaveLength(1);
      await rename(join(target, 'marker-offline'), join(target, '.verity-backup-target'));
      await journal.flush();
      await journal.queue('second-device');
      let result = await readRevocations(target, recoveryKey);
      expect([...result.revokedIds].sort()).toEqual(['revoked-while-paused', 'second-device']);
      expect(result.findings).toEqual([]);
      expect(await readdir(join(state, 'revocation-outbox'))).toEqual([]);
      const generation = join(target, 'revocations', `${installationId}-k1`);
      const first = await readFile(join(generation, '1'));
      await rm(join(generation, '1'));
      result = await readRevocations(target, recoveryKey);
      expect(result.findings).toContain(`${installationId}-k1: sequence-gap`);
      await writeFile(join(generation, '1'), await readFile(join(generation, '2')));
      result = await readRevocations(target, recoveryKey);
      expect(result.findings).toContain(`${installationId}-k1/1: entry-unreadable`);
      expect(result.revokedIds.has('second-device')).toBe(true);
      await writeFile(join(generation, '1'), first);
      await writeFile(join(generation, 'sequence'), '3');
      result = await readRevocations(target, recoveryKey);
      expect(result.findings).toContain(`${installationId}-k1: reserved-sequence-gap`);
      const { recoveryKey: otherKey } = await generateBackupKeys();
      result = await readRevocations(target, otherKey);
      expect(result.findings).toContain(`${installationId}-k1: checkpoint-unreadable`);
      await rename(generation, join(root, 'outside-generation'));
      await symlink(join(root, 'outside-generation'), generation);
      await expect(readRevocations(target, recoveryKey)).rejects.toThrow();
    } finally {
      await destination.close();
    }
  });
});
