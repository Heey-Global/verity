import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { InstallerRestoreStaging } from './restore-staging.js';
import type { RestoreJob } from './restore-job.js';
const fake = vi.hoisted(() => ({
  snapshot: vi.fn(),
  extract: vi.fn(),
  identity: vi.fn(),
  history: vi.fn(),
}));
vi.mock('./repository.js', async (original) => ({
  ...(await original<typeof import('./repository.js')>()),
  readSnapshot: fake.snapshot,
}));
vi.mock('./staging.js', () => ({ stageSnapshot: fake.extract }));
vi.mock('./restore-identity.js', () => ({ verifyRestoredIdentity: fake.identity }));
vi.mock('./restore-identity-history.js', () => ({ assertRestorableIdentity: fake.history }));
it('authenticates the release, architecture and recovery capability before extracting or touching a database', async () => {
  vi.resetAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'restore-verification-'));
  const installationId = randomUUID();
  const job: RestoreJob = {
    format: 1,
    id: randomUUID(),
    installationId: randomUUID(),
    selection: {
      source: '/copied/backup',
      repository: installationId + '-r1',
      sequence: 1,
      kind: 'manual',
      newIdentity: false,
    },
    verified: null,
    phase: 'verifying',
    startedAt: 1,
    updatedAt: 1,
  };
  const checkRelease = vi.fn(async () => {});
  const supportsRecovery = vi.fn(async () => false);
  const withFreshDatabase = vi.fn(async () => {});
  const stageHost = vi.fn(async () => {});
  const staging = new InstallerRestoreStaging({
    root,
    liveRoot: '/srv/verity',
    identityHistoryRoot: root,
    checkRelease,
    supportsRecovery,
    withFreshDatabase,
    stageHost,
    stageData: vi.fn(),
  });
  const manifest = {
    repository: job.selection.repository,
    schema: 'schema',
    capture: {
      image: 'official-pinned-image',
      architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
      caKey: { installationId },
    },
    files: [],
  };
  try {
    fake.snapshot.mockRejectedValueOnce(new Error('signature invalid'));
    await expect(staging.verify(job, 'key')).rejects.toThrow('signature invalid');
    expect(checkRelease).not.toHaveBeenCalled();
    fake.snapshot.mockResolvedValue(manifest);
    checkRelease.mockRejectedValueOnce(new Error('unsigned release'));
    await expect(staging.verify(job, 'key')).rejects.toThrow('unsigned release');
    expect(supportsRecovery).not.toHaveBeenCalled();
    await expect(staging.verify(job, 'key')).rejects.toThrow(
      'does not support restricted recovery',
    );
    expect(fake.extract).not.toHaveBeenCalled();
    expect(withFreshDatabase).not.toHaveBeenCalled();
    expect(stageHost).not.toHaveBeenCalled();
    supportsRecovery.mockResolvedValue(true);
    const tree = join(root, 'private-tree');
    await mkdir(tree);
    fake.extract.mockResolvedValue(tree);
    const caPrivateKey = Buffer.from('private-ca-key');
    fake.identity.mockResolvedValue({ deploymentId: 'preserved-identity', caPrivateKey });
    await expect(staging.verify(job, 'key')).resolves.toMatchObject({
      deploymentId: 'preserved-identity',
      sourceInstallationId: installationId,
    });
    const verified = await staging.verify(job, 'key');
    fake.history.mockRejectedValueOnce(
      new Error('Snapshot identity was retired; restore requires --new-identity'),
    );
    await expect(staging.verify(job, 'key')).rejects.toThrow('identity was retired');
    expect(withFreshDatabase).not.toHaveBeenCalled();
    expect(stageHost).not.toHaveBeenCalled();
    fake.snapshot.mockResolvedValue({ ...manifest, release: 'replaced-after-verification' });
    await expect(staging.stage({ ...job, verified, phase: 'staging' }, 'key')).rejects.toThrow(
      'Snapshot changed',
    );
    expect(caPrivateKey.every((byte) => byte === 0)).toBe(true);
    expect(withFreshDatabase).not.toHaveBeenCalled();
    expect(stageHost).not.toHaveBeenCalled();
    fake.snapshot.mockResolvedValue({
      ...manifest,
      capture: { ...manifest.capture, architecture: 'unsupported' },
    });
    const calls = checkRelease.mock.calls.length;
    await expect(staging.verify(job, 'key')).rejects.toThrow('no native release');
    expect(checkRelease).toHaveBeenCalledTimes(calls);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
