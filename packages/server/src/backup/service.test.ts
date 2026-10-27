import type { DockerClient } from '../docker.js';
import * as snapshotProbe from './probe.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BackupService, type BackupServiceOptions } from './service.js';
import * as identityRequest from './identity-request.js';
import { generateBackupKeys } from './crypto.js';
import { sealCaIdentityReceipt } from './identity-receipt.js';
import { readRevocations } from './revocations.js';
import { writeBackupIdentityFixture } from './testing.js';

it('commits only after identity confirmation, skips abandoned repositories and syncs revocations while paused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-service-'));
  let service: BackupService | undefined;
  const helper = vi.spyOn(identityRequest, 'requestBackupIdentity');
  const probe = vi.spyOn(snapshotProbe, 'probeSnapshot');
  try {
    const installationId = randomUUID();
    const targetId = randomUUID();
    const { host } = await generateBackupKeys();
    await writeBackupIdentityFixture(root, host, installationId);
    const pairing = join(root, 'pairing');
    const destination = join(root, 'destination');
    const identityRequests = join(root, 'requests');
    for (const path of [pairing, destination, identityRequests]) await mkdir(path);
    await writeFile(join(pairing, 'installation-id'), installationId);
    await writeFile(join(pairing, 'backup-postgres-password'), 'a'.repeat(64));
    await writeFile(join(destination, '.verity-backup-target'), targetId);
    let notify: (() => Promise<void>) | undefined;
    const unsubscribe = vi.fn();
    const store = {
      subscribeBackupRevocations: vi.fn((listener: () => Promise<void>) => {
        notify = listener;
        return unsubscribe;
      }),
      setBackupJournaling: vi.fn(async () => undefined),
      backupGitRepositoryKey: vi.fn(async () => randomUUID()),
      listBackupRevocations: vi.fn(
        async () => [] as { id: string; deviceId: string; revokedAt: string }[],
      ),
      acknowledgeBackupRevocation: vi.fn(async () => undefined),
    };
    const connect = vi.fn<BackupServiceOptions['connect']>(async () => {
      throw new Error('Paused capture must not connect');
    });
    const options: BackupServiceOptions = {
      root,
      probe: {
        docker: { removeContainer: vi.fn(async () => undefined) } as unknown as DockerClient,
        network: 'verity-net',
        tufCachePath: join(root, 'tuf'),
      },
      pairing,
      destination,
      identityRequests,
      identityRoot: join(root, 'identity'),
      image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
      release: 'test',
      schema: '0164',
      architecture: 'amd64',
      connect,
      store,
      onError: vi.fn(),
    };
    service = await BackupService.open(options);
    expect(service).toBeDefined();
    const candidate = await service!.beginSetup();
    helper.mockRejectedValueOnce(new Error('Helper unavailable'));
    await expect(service!.confirmSetup(candidate.id, candidate.recoveryKey)).rejects.toThrow(
      'Helper unavailable',
    );
    expect(await service!.status()).toEqual({ configured: false, alerts: [] });
    expect(store.setBackupJournaling).not.toHaveBeenCalled();
    helper.mockImplementation(async (request) => {
      const path = join(root, 'confirmed-receipt');
      await writeFile(
        path,
        await sealCaIdentityReceipt(
          {
            recipient: request.recipient,
            installationId: request.installationId,
            keyGeneration: request.keyGeneration,
          },
          await readFile(join(root, 'ca.pem')),
          request.certificate,
        ),
      );
      return path;
    });
    await service!.confirmSetup(candidate.id, candidate.recoveryKey);
    const state = JSON.parse(await readFile(join(root, 'backup-state/state'), 'utf8')) as {
      repositoryNumber: number;
      keyGeneration: number;
    };
    expect(state.repositoryNumber).toBe(2);
    expect(state.keyGeneration).toBe(2);
    expect(JSON.stringify(state)).not.toContain(candidate.recoveryKey);
    await service!.setPaused(true);
    await service!.tick();
    expect(store.listBackupRevocations).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    const event = {
      id: randomUUID(),
      deviceId: 'immediately-revoked',
      revokedAt: new Date().toISOString(),
    };
    store.listBackupRevocations.mockResolvedValueOnce([event]);
    await notify!();
    expect(store.acknowledgeBackupRevocation).toHaveBeenCalledWith(event.id);
    expect(
      (await readRevocations(destination, candidate.recoveryKey)).revokedIds.has(event.deviceId),
    ).toBe(true);
    const repositoryName = installationId + '-r' + state.repositoryNumber;
    await writeFile(
      join(destination, 'repositories', repositoryName, 'snapshots', '1-scheduled'),
      'mocked-authenticated-snapshot',
    );
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    probe.mockImplementationOnce(async (request) => {
      expect(request.recoveryKey).toBe(candidate.recoveryKey);
      entered();
      await blocked;
      return {
        repository: request.repository,
        sequence: request.sequence,
        finishedAt: new Date().toISOString(),
        deploymentId: 'test',
        files: 1,
        plaintextBytes: '1',
        warnings: [],
        revocationFindings: [],
      };
    });
    const job = await service!.startProbe(candidate.recoveryKey);
    await started;
    await expect(service!.startProbe(candidate.recoveryKey)).rejects.toThrow();
    await expect(service!.tick()).rejects.toThrow('already in progress');
    finish();
    await expect.poll(() => service!.probeStatus(job.id)?.status).toBe('succeeded');
    await expect
      .poll(async () => {
        try {
          await service!.tick();
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    const proof = (await service!.status()).lastProbe;
    expect(proof).toMatchObject({ repository: repositoryName, sequence: 1 });
    probe.mockRejectedValueOnce(new Error('private-recovery-key'));
    const failed = await service!.startProbe(candidate.recoveryKey);
    await expect.poll(() => service!.probeStatus(failed.id)?.status).toBe('failed');
    expect((await service!.status()).lastProbe).toEqual(proof);
    expect(await readFile(join(root, 'backup-state', 'probe-job'), 'utf8')).not.toContain(
      candidate.recoveryKey,
    );
    await service!.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await expect(service!.beginSetup()).rejects.toThrow('closed');
    service = await BackupService.open(options);
    expect(await service!.status()).toMatchObject({
      configured: true,
      paused: true,
      alerts: [],
    });
  } finally {
    helper.mockRestore();
    probe.mockRestore();
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});
