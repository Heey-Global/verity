import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { confirmRecoveryKey, generateBackupKeys } from './crypto.js';
import { BackupKeyReplacement } from './key-replacement.js';
import { BackupSetup } from './setup.js';
import { BackupStateStore, type BackupState } from './state.js';
import { DEFAULT_BACKUP_INTERVAL_MS } from './scheduler.js';

it('keeps cancelled replacement in memory and resumes confirmed exposure retirement before publication after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-replacement-'));
  try {
    const state = new BackupStateStore(root, randomUUID());
    const old = await generateBackupKeys();
    const previous: BackupState = {
      format: 1,
      installationId: state.installationId,
      targetId: randomUUID(),
      repositoryNumber: 1,
      keyGeneration: 1,
      confirmedAt: 1,
      host: old.host,
      lastProbe: null,
      schedule: {
        intervalMs: DEFAULT_BACKUP_INTERVAL_MS,
        paused: true,
        lastSuccess: 1,
        lastAttempt: 1,
        failures: 0,
      },
    };
    await state.create(previous);
    const setup = new BackupSetup(async () => !!(await state.load()), Date.now, true);
    const cancelled = await setup.begin();
    setup.cancel();
    const commit = vi.fn();
    await expect(setup.confirm(cancelled.id, cancelled.recoveryKey, commit)).rejects.toThrow(
      'expired',
    );
    expect(commit).not.toHaveBeenCalled();
    expect(await state.load()).toEqual(previous);
    const candidate = await setup.begin();
    const journal = new BackupKeyReplacement(state);
    const retire = vi.fn(async () => undefined);
    const publish = vi.fn(async () => {
      throw new Error('helper unavailable');
    });
    await expect(
      setup.confirm(candidate.id, candidate.recoveryKey, async (host) => {
        await journal.save({
          format: 1,
          id: candidate.id,
          reason: 'exposed',
          previous,
          next: { ...previous, host, keyGeneration: 2, repositoryNumber: 2 },
          complete: false,
        });
        await journal.resume({ retire, publish });
      }),
    ).rejects.toThrow('helper unavailable');
    expect(retire).toHaveBeenCalledOnce();
    expect(await state.load()).toEqual(previous);
    const text = await readFile(join(root, 'key-replacement'), 'utf8');
    expect(text).not.toContain(candidate.recoveryKey);
    expect(text).not.toContain(old.recoveryKey);
    const ordering: string[] = [];
    const restarted = new BackupKeyReplacement(new BackupStateStore(root, state.installationId));
    await restarted.resume({
      retire: async () => {
        ordering.push('retire');
      },
      publish: async () => {
        ordering.push('publish');
      },
    });
    expect(ordering).toEqual(['retire', 'publish']);
    expect((await state.load())!.keyGeneration).toBe(2);
    expect((await restarted.load())!.complete).toBe(true);
    await restarted.resume({ retire, publish });
    expect(publish).toHaveBeenCalledOnce();
    // The old key still confirms its historical recipient, independent of the new generation.
    await confirmRecoveryKey(old.recoveryKey, previous.host);
    expect((await state.load())!.host.recipient).not.toBe(previous.host.recipient);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not retire a lost-key generation and rejects concurrent state changes on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-replacement-'));
  try {
    const state = new BackupStateStore(root, randomUUID());
    const { host } = await generateBackupKeys();
    const previous: BackupState = {
      format: 1,
      installationId: state.installationId,
      targetId: randomUUID(),
      repositoryNumber: 1,
      keyGeneration: 1,
      confirmedAt: 1,
      host,
      lastProbe: null,
      schedule: {
        intervalMs: DEFAULT_BACKUP_INTERVAL_MS,
        paused: false,
        lastSuccess: null,
        lastAttempt: null,
        failures: 0,
      },
    };
    await state.create(previous);
    const next = {
      ...previous,
      host: (await generateBackupKeys()).host,
      keyGeneration: 2,
      repositoryNumber: 2,
    };
    const journal = new BackupKeyReplacement(state);
    await journal.save({
      format: 1,
      id: randomUUID(),
      reason: 'lost',
      previous,
      next,
      complete: false,
    });
    const retire = vi.fn(async () => undefined);
    await journal.resume({ retire, publish: async () => undefined });
    expect(retire).not.toHaveBeenCalled();
    expect((await state.load())!.host).toEqual(next.host);
    await expect(state.replace(previous, { ...next, targetId: randomUUID() })).rejects.toThrow(
      'Invalid backup replacement',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
