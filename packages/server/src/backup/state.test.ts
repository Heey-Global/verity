import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateBackupKeys } from './crypto.js';
import { BackupSetup } from './setup.js';
import { BackupStateStore, type BackupState } from './state.js';
import { DEFAULT_BACKUP_INTERVAL_MS } from './scheduler.js';

describe('confirmed host-only backup state', () => {
  it('stores only non-decrypting host keys after confirmation and preserves state across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-backup-state-'));
    try {
      const installationId = randomUUID();
      const store = new BackupStateStore(root, installationId);
      let now = 1000;
      const setup = new BackupSetup(
        async () => (await store.load()) !== undefined,
        () => now,
      );
      const candidate = await setup.begin();
      expect(await store.load()).toBeUndefined();
      const { recoveryKey: wrong } = await generateBackupKeys();
      let commits = 0;
      const commit = async (host: BackupState['host']) => {
        commits++;
        await store.create({
          format: 1,
          installationId,
          targetId: randomUUID(),
          keyGeneration: 1,
          repositoryNumber: 1,
          confirmedAt: now,
          host,
          lastProbe: null,
          schedule: {
            intervalMs: DEFAULT_BACKUP_INTERVAL_MS,
            paused: false,
            lastSuccess: null,
            lastAttempt: null,
            failures: 0,
          },
        });
      };
      await expect(setup.confirm(candidate.id, wrong, commit)).rejects.toThrow('does not match');
      expect(commits).toBe(0);
      await setup.confirm(candidate.id, candidate.recoveryKey, commit);
      const text = await readFile(join(root, 'state'), 'utf8');
      expect(text).not.toContain(candidate.recoveryKey);
      expect(text).not.toContain('AGE-SECRET-KEY-');
      expect((await stat(join(root, 'state'))).mode & 0o777).toBe(0o600);
      const restarted = new BackupStateStore(root, installationId);
      expect((await restarted.load())!.schedule.lastSuccess).toBeNull();
      await restarted.update((state) => ({
        ...state,
        schedule: { ...state.schedule, paused: true },
      }));
      await restarted.update((state) => ({
        ...state,
        schedule: { ...state.schedule, lastAttempt: 2000, failures: 1 },
      }));
      expect((await store.load())!.schedule).toMatchObject({
        paused: true,
        failures: 1,
        lastAttempt: 2000,
      });
      await expect(new BackupStateStore(root, randomUUID()).load()).rejects.toThrow(
        'state is invalid',
      );
      await expect(store.update((state) => ({ ...state, repositoryNumber: 2 }))).rejects.toThrow(
        'new repository',
      );
      await expect(setup.begin()).rejects.toThrow('already configured');
      now = 2000;
      await expect(setup.confirm(candidate.id, candidate.recoveryKey, commit)).rejects.toThrow(
        'expired',
      );
      expect(commits).toBe(1);
      await writeFile(join(root, 'state'), '{}');
      await expect(store.load()).rejects.toThrow('state is invalid');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('abandons expired or cancelled candidates without persisting recovery material', async () => {
    let now = 0;
    const setup = new BackupSetup(
      () => Promise.resolve(false),
      () => now,
    );
    const candidate = await setup.begin();
    now = candidate.expiresAt;
    await expect(
      setup.confirm(candidate.id, candidate.recoveryKey, async () => {
        throw new Error('must not commit');
      }),
    ).rejects.toThrow('expired');
    const next = await setup.begin();
    setup.cancel();
    await expect(
      setup.confirm(next.id, next.recoveryKey, async () => {
        throw new Error('must not commit');
      }),
    ).rejects.toThrow('expired');
  });
});
