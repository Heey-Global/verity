import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { backupProvisionPlan } from './backup-provisioning.js';
import { scheduleLegacyBackupUpgrade } from './backup-upgrade.js';
import type { UpdatePreparationDocker } from './docker-update-preparation.js';
import { initializeManagedDeployment } from './managed-deployment.js';
import {
  advanceUpdate,
  advanceCutover,
  advanceCompanionReconciliation,
  archiveUpdateJournal,
  beginUpdate,
  failUpdate,
  readUpdateJournal,
} from './update-journal.js';
vi.mock('./backup-provisioning.js', () => ({
  BACKUP_PROVISION_LABEL: 'org.verity.backup-provisioning',
  backupProvisionPlan: vi.fn(),
}));
const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(mounted = false) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-backup-'));
  roots.push(root);
  await initializeManagedDeployment({
    root,
    deploymentId: 'test',
    spec: {
      image,
      environment: [],
      mounts: [
        ...(mounted
          ? [
              {
                source: { kind: 'bind' as const, path: '/srv/backups' },
                target: '/run/verity-backups',
                readOnly: false,
              },
              {
                source: { kind: 'bind' as const, path: '/var/lib/verity/backup-identity' },
                target: '/run/verity-backup-identity',
                readOnly: false,
              },
            ]
          : []),
        {
          source: { kind: 'bind', path: '/etc/verity' },
          target: '/run/verity-pairing',
          readOnly: true,
        },
        { source: { kind: 'volume', name: 'verity-data' }, target: '/srv/verity', readOnly: false },
        {
          source: { kind: 'volume', name: 'verity-agent-gateway-control' },
          target: '/run/verity-agent-gateway',
          readOnly: false,
        },
        {
          source: { kind: 'bind', path: '/var/run/docker.sock' },
          target: '/var/run/docker.sock',
          readOnly: false,
        },
      ],
      user: { uid: 1000, gid: 1000, supplementaryGids: [] },
      restart: 'unless-stopped',
      network: 'verity-net',
      platform: { os: 'linux', architecture: 'amd64' },
      security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: [] },
    },
  });
  vi.mocked(backupProvisionPlan).mockResolvedValue({
    version: 1,
    statePath: '/etc/verity',
    backupPath: '/srv/backups',
    identityPath: '/var/lib/verity/backup-identity',
    provisioned: false,
  });
  const docker = {
    inspectImageLabels: vi.fn().mockResolvedValue({ 'org.verity.backup-provisioning': '1' }),
    inspectImageEnv: vi.fn().mockResolvedValue(['VERITY_SERVER_VERSION=4.66.0']),
  } as unknown as UpdatePreparationDocker;
  return { managedRoot: root, docker };
}
async function completed(root: string, key = 'old-release') {
  await beginUpdate({
    root,
    deploymentId: 'test',
    previousDigest: image,
    targetDigest: image,
    currentGeneration: 7,
    idempotencyKey: key,
  });
  for (const [from, to] of [
    ['requested', 'pulling'],
    ['pulling', 'verifying-image'],
    ['verifying-image', 'preflight'],
    ['preflight', 'creating-standby'],
  ] as const)
    await advanceUpdate(root, from, to);
  await advanceUpdate(root, 'creating-standby', 'standby', {
    candidate: { containerId: 'b'.repeat(64), containerName: 'verity-managed-server-g8' },
  });
  for (const [from, to] of [
    ['standby', 'quiescing-old'],
    ['quiescing-old', 'handing-off-key'],
    ['handing-off-key', 'activating-candidate'],
    ['activating-candidate', 'checking-candidate'],
    ['checking-candidate', 'draining-gateway'],
    ['draining-gateway', 'switching-gateway'],
    ['switching-gateway', 'observing-candidate'],
    ['observing-candidate', 'committed'],
  ] as const)
    await advanceCutover(root, from, to, { previousContainerId: 'c'.repeat(64) });
  await advanceCompanionReconciliation(root, 'committed', 'reconciling-companions');
  await advanceCompanionReconciliation(root, 'reconciling-companions', 'completed');
}
it('archives the old updater handoff and starts a monotone same-digest guarded update', async () => {
  const options = await setup();
  await completed(options.managedRoot);
  expect(await scheduleLegacyBackupUpgrade(options)).toBe(true);
  expect(await readUpdateJournal(options.managedRoot)).toMatchObject({
    phase: 'requested',
    generation: 9,
    previousDigest: image,
    targetDigest: image,
  });
  expect(await readdir(options.managedRoot)).toContain('update-journal-g8.json');
  expect(await scheduleLegacyBackupUpgrade(options)).toBe(false);
});
it.each([false, true])(
  'recovers an archive/create crash with backup mounts %s',
  async (mounted) => {
    const options = await setup(mounted);
    await completed(options.managedRoot);
    await archiveUpdateJournal(options.managedRoot);
    expect(await scheduleLegacyBackupUpgrade(options)).toBe(true);
    expect(await readUpdateJournal(options.managedRoot)).toMatchObject({ generation: 9 });
  },
);
it('does not reboot-loop after a completed repair or retry a failed operation automatically', async () => {
  const options = await setup();
  await completed(options.managedRoot, `backup-provision-v1:${image.split('@')[1]}`);
  expect(await scheduleLegacyBackupUpgrade(options)).toBe(false);
  await archiveUpdateJournal(options.managedRoot);
  await scheduleLegacyBackupUpgrade(options);
  await failUpdate(options.managedRoot, 'requested', 'fixture-failure');
  expect(await scheduleLegacyBackupUpgrade(options)).toBe(false);
});
it('does not schedule when the release predates the contract or verification fails', async () => {
  const options = await setup();
  vi.mocked(options.docker.inspectImageLabels!).mockResolvedValue({});
  expect(await scheduleLegacyBackupUpgrade(options)).toBe(false);
  vi.mocked(options.docker.inspectImageEnv!).mockResolvedValue(['VERITY_SERVER_VERSION=0.0.0-dev']);
  await expect(scheduleLegacyBackupUpgrade(options)).rejects.toThrow('released');
  expect(await readUpdateJournal(options.managedRoot)).toBeNull();
});

it('journals unreadable preparation state for visible failure handling, but skips a ready host', async () => {
  const options = await setup(true);
  await completed(options.managedRoot);
  vi.mocked(backupProvisionPlan).mockResolvedValue({
    version: 1,
    statePath: '/etc/verity',
    backupPath: '/srv/backups',
    identityPath: '/var/lib/verity/backup-identity',
    provisioned: true,
  });
  expect(await scheduleLegacyBackupUpgrade(options)).toBe(false);
  vi.mocked(backupProvisionPlan).mockRejectedValue(new Error('unsafe state'));
  expect(await scheduleLegacyBackupUpgrade(options)).toBe(true);
  expect(await readUpdateJournal(options.managedRoot)).toMatchObject({ phase: 'requested' });
});

it('does not race the installer during the first boot of a newly sealed installation', async () => {
  const options = await setup(true);
  expect(await scheduleLegacyBackupUpgrade(options)).toBe(false);
  expect(await readUpdateJournal(options.managedRoot)).toBeNull();
  expect(backupProvisionPlan).not.toHaveBeenCalled();
});
