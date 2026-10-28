import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { generateBackupKeys } from './crypto.js';
import { BackupDestination } from './destination.js';
import { BackupRepository } from './repository.js';
import { registerBackupGeneration, maintainBackupGenerations } from './generation-maintenance.js';
import type { BackupState } from './state.js';
import { BackupRevocationJournal, readRevocations } from './revocations.js';

it('keeps live generations, expires only globally unretained history and retries journal retirement without gaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-generations-'));
  const target = join(root, 'destination');
  const local = join(root, 'state');
  await mkdir(target);
  await mkdir(local);
  const installationId = randomUUID(),
    targetId = randomUUID();
  await writeFile(join(target, '.verity-backup-target'), targetId);
  const destination = await BackupDestination.open(target, targetId);
  const old = await generateBackupKeys(),
    current = await generateBackupKeys();
  const now = Date.UTC(2026, 9, 28);
  const state = (number: number, host: BackupState['host']): BackupState => ({
    format: 1,
    installationId,
    targetId,
    keyGeneration: number,
    repositoryNumber: number,
    host,
    confirmedAt: now,
    lastProbe: null,
    schedule: {
      intervalMs: 3600000,
      paused: false,
      lastSuccess: now,
      lastAttempt: now,
      failures: 0,
    },
  });
  const a = state(1, old.host),
    b = state(2, current.host);
  const repository = (value: BackupState) =>
    new BackupRepository(
      target,
      local,
      `${installationId}-r${value.repositoryNumber}`,
      value.host,
      destination,
    );
  const first = repository(a),
    second = repository(b);
  const capture = async (repo: BackupRepository, time: number, content: string) =>
    repo.capture(
      (async function* () {
        yield {
          path: 'file',
          mode: 0o600,
          source: (async function* () {
            yield Buffer.from(content);
          })(),
        };
      })(),
      { release: 'test', schema: 1, capturedAt: new Date(time).toISOString() },
    );
  try {
    await first.initialize();
    await second.initialize();
    await registerBackupGeneration(local, a);
    await registerBackupGeneration(local, b);
    await mkdir(destination.pinnedPath('identity'));
    const ca = destination.pinnedPath('identity', `${installationId}-ca-key-k1`);
    await writeFile(ca, 'encrypted CA');
    const journal = new BackupRevocationJournal(
      destination,
      join(local, 'key-1'),
      installationId,
      1,
      old.host,
    );
    await journal.queue('revoked-old-device');
    await capture(first, now, 'old generation still live');
    await capture(second, now, 'newest');
    await maintainBackupGenerations(local, destination, b, now);
    expect(await readFile(ca, 'utf8')).toBe('encrypted CA');
    expect(
      (await readRevocations(target, old.recoveryKey)).revokedIds.has('revoked-old-device'),
    ).toBe(true);
    // Populate newer calendar buckets; the old generation eventually has no retention claim.
    const later = now + 400 * 86400000;
    for (let day = 0; day < 8; day++)
      await capture(second, later - day * 31 * 86400000, String(day));
    const stop = vi.fn(async () => false);
    await maintainBackupGenerations(local, destination, b, later, stop);
    expect((await readdir(join(first.root, 'snapshots'))).length).toBe(1);
    const foreign = `${randomUUID()}-r1`;
    await mkdir(destination.pinnedPath('repositories', foreign));
    await writeFile(destination.pinnedPath('repositories', foreign, 'untouched'), 'foreign');
    await maintainBackupGenerations(local, destination, b, later);
    expect(await readdir(join(first.root, 'snapshots'))).toEqual([]);
    await expect(readFile(ca)).rejects.toThrow();
    let revoked = await readRevocations(target, old.recoveryKey);
    expect(revoked.findings.filter((value) => value.startsWith(`${installationId}-k1`))).toEqual(
      [],
    );
    expect(revoked.revokedIds.has('revoked-old-device')).toBe(false);
    await maintainBackupGenerations(local, destination, b, later);
    await journal.queue('after-pruning');
    revoked = await readRevocations(target, old.recoveryKey);
    expect(revoked.revokedIds.has('after-pruning')).toBe(true);
    expect(revoked.findings.filter((value) => value.startsWith(`${installationId}-k1`))).toEqual(
      [],
    );
    expect(
      await readFile(destination.pinnedPath('repositories', foreign, 'untouched'), 'utf8'),
    ).toBe('foreign');
    // Missing ownership evidence stops every prune before any generation can lose snapshots.
    await mkdir(destination.pinnedPath('repositories', `${installationId}-r3`));
    await expect(maintainBackupGenerations(local, destination, b, later)).rejects.toThrow(
      'generation catalog',
    );
  } finally {
    await destination.close();
    await rm(root, { recursive: true, force: true });
  }
});
