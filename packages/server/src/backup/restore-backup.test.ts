import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { generateBackupKeys } from './crypto.js';
import { BackupDestination } from './destination.js';
import { BackupRepository } from './repository.js';
import { BackupStateStore } from './state.js';
import { openCaIdentityReceipt } from './identity-receipt.js';
import { writeBackupIdentityFixture } from './testing.js';
import { initializeRestoredBackup } from './restore-backup.js';
import type { RestoreJob } from './restore-job.js';
it('publishes the new installation CA before activation, retries partial activation and preserves the source repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-backup-'));
  const target = join(root, 'backup');
  await mkdir(target);
  const targetId = randomUUID();
  await writeFile(join(target, '.verity-backup-target'), targetId);
  const destination = await BackupDestination.open(target, targetId);
  const { host, recoveryKey } = await generateBackupKeys();
  const sourceId = randomUUID();
  const repository = sourceId + '-r1';
  await mkdir(join(target, 'repositories'));
  await new BackupRepository(
    join(target, 'repositories'),
    join(root, 'source-state'),
    repository,
    host,
  ).initialize();
  await writeBackupIdentityFixture(root, host, sourceId);
  const sourceKeys = await readFile(join(target, 'repositories', repository, 'keys'));
  const job: RestoreJob = {
    format: 1,
    id: randomUUID(),
    installationId: randomUUID(),
    selection: { source: target, repository, sequence: 1, kind: 'manual', newIdentity: false },
    verified: {
      image: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      schema: 'schema',
      architecture: 'amd64',
      deploymentId: 'deployment-fixture',
      sourceInstallationId: sourceId,
    },
    phase: 'accepted',
    startedAt: 1,
    updatedAt: 1,
  };
  const stateRoot = join(root, 'new-state');
  const certificate = await readFile(join(root, 'identity/tls-ca-cert.pem'));
  const caPrivateKey = await readFile(join(root, 'ca.pem'));
  let fail = true;
  const enable = vi.fn(async () => {
    const state = await new BackupStateStore(stateRoot, job.installationId).load();
    expect(state!.schedule.paused).toBe(true);
    const receipt = await readFile(
      join(target, 'identity', `${job.installationId}-ca-key-k${state!.keyGeneration}`),
    );
    expect(
      openCaIdentityReceipt(
        receipt,
        certificate,
        job.installationId,
        state!.keyGeneration,
        host.recipient,
      ).length,
    ).toBeGreaterThan(0);
    if (fail) throw new Error('helper unavailable');
  });
  const options = { job, recoveryKey, stateRoot, destination, certificate, caPrivateKey, enable };
  try {
    await expect(
      initializeRestoredBackup({ ...options, job: { ...job, phase: 'promoted' } }),
    ).rejects.toThrow('accepted installation');
    await expect(initializeRestoredBackup(options)).rejects.toThrow('helper unavailable');
    expect(
      (await new BackupStateStore(stateRoot, job.installationId).load())!.schedule.paused,
    ).toBe(true);
    fail = false;
    const active = await initializeRestoredBackup(options);
    expect(active.schedule.paused).toBe(false);
    expect(active.installationId).not.toBe(sourceId);
    await initializeRestoredBackup(options);
    expect(enable).toHaveBeenCalledTimes(2);
    expect(await readFile(join(target, 'repositories', repository, 'keys'))).toEqual(sourceKeys);
    expect((await readdir(join(target, 'repositories'))).sort()).toEqual(
      [repository, job.installationId + '-r1'].sort(),
    );
    const statePath = join(stateRoot, 'state');
    const other = await generateBackupKeys();
    const unrelated = Buffer.from(JSON.stringify({ ...active, host: other.host }));
    await writeFile(statePath, unrelated);
    await expect(initializeRestoredBackup(options)).rejects.toThrow('unrelated identity');
    expect(await readFile(statePath)).toEqual(unrelated);
    expect(enable).toHaveBeenCalledTimes(2);
  } finally {
    caPrivateKey.fill(0);
    await destination.close();
    await rm(root, { recursive: true, force: true });
  }
});
