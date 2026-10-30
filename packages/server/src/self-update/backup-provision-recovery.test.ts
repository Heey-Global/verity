import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backupProvisionPlan, provisionBackupHost } from './backup-provisioning.js';
import { recoverBackupProvisioning } from './backup-provision-recovery.js';
import {
  adoptedDeployment,
  DEPLOYMENT_ID,
  oldImage,
  newImage,
} from './managed-daemon.test-helper.js';
import { readManagedDeployment } from './managed-deployment.js';
import {
  advanceUpdate,
  beginUpdate,
  readUpdateJournal,
  withUpdateJournalLease,
} from './update-journal.js';

vi.mock('./backup-provisioning.js', () => ({
  backupProvisionPlan: vi.fn(),
  provisionBackupHost: vi.fn(),
}));
const roots: string[] = [];
const plan = {
  version: 1 as const,
  statePath: '/etc/verity',
  backupPath: '/srv/backups',
  identityPath: '/var/lib/verity/backup-identity',
  provisioned: false,
};
beforeEach(() => {
  vi.mocked(backupProvisionPlan).mockResolvedValue(plan);
  vi.mocked(provisionBackupHost).mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(phase: 'preflight' | 'creating-standby' = 'creating-standby') {
  const { root, daemon, oldContainerId } = await adoptedDeployment('backup-repair');
  roots.push(root);
  await beginUpdate({
    root,
    deploymentId: DEPLOYMENT_ID,
    idempotencyKey: 'backup-repair',
    previousDigest: oldImage,
    targetDigest: newImage,
    currentGeneration: 180,
  });
  for (const [from, to] of [
    ['requested', 'pulling'],
    ['pulling', 'verifying-image'],
    ['verifying-image', 'preflight'],
    ['preflight', 'creating-standby'],
  ] as const) {
    await advanceUpdate(root, from, to);
    if (to === phase) break;
  }
  return { options: { managedRoot: root, docker: daemon.docker }, oldContainerId };
}

it('checks without host writes and repairs the exact old target without rewriting the operation', async () => {
  const { options } = await setup();
  const journal = await readUpdateJournal(options.managedRoot);
  const state = await readManagedDeployment(options.managedRoot);
  const { provisioned, ...expected } = await recoverBackupProvisioning(options);
  expect(provisioned).toBe(false);
  expect(provisionBackupHost).not.toHaveBeenCalled();
  const result = await recoverBackupProvisioning({ ...options, expected });
  expect(result.provisioned).toBe(true);
  expect(provisionBackupHost).toHaveBeenCalledWith(
    options.docker,
    state.managed && state.spec,
    newImage,
    plan,
  );
  expect(await readUpdateJournal(options.managedRoot)).toEqual(journal);
  expect(await readManagedDeployment(options.managedRoot)).toEqual(state);
  expect(options.docker.removeContainer).not.toHaveBeenCalled();
});

it('refuses an active updater lease before starting any helper', async () => {
  const { options } = await setup();
  await withUpdateJournalLease(options.managedRoot, async () => {
    await expect(recoverBackupProvisioning(options)).rejects.toThrow('another updater process');
  });
  expect(backupProvisionPlan).not.toHaveBeenCalled();
});

it('refuses each stale snapshot binding before any host job', async () => {
  const { options } = await setup();
  const { provisioned, ...expected } = await recoverBackupProvisioning(options);
  expect(provisioned).toBe(false);
  vi.mocked(backupProvisionPlan).mockClear();
  for (const changed of [
    { updateId: 'different' },
    { generation: 182 },
    { targetDigest: oldImage },
    { journalChecksum: 'changed' },
    { deploymentChecksum: 'changed' },
  ])
    await expect(
      recoverBackupProvisioning({ ...options, expected: { ...expected, ...changed } }),
    ).rejects.toThrow('changed since');
  expect(backupProvisionPlan).not.toHaveBeenCalled();
  expect(provisionBackupHost).not.toHaveBeenCalled();
});

it('refuses a prepared candidate rather than bypassing cutover ownership', async () => {
  const { options } = await setup();
  await advanceUpdate(options.managedRoot, 'creating-standby', 'standby', {
    candidate: { containerId: 'c'.repeat(64), containerName: 'verity-managed-server-g181' },
  });
  await expect(recoverBackupProvisioning(options)).rejects.toThrow('pre-cutover');
  expect(backupProvisionPlan).not.toHaveBeenCalled();
});

it('refuses to repair before the target has passed preflight', async () => {
  const { options } = await setup('preflight');
  await expect(recoverBackupProvisioning(options)).rejects.toThrow('pre-cutover');
  expect(backupProvisionPlan).not.toHaveBeenCalled();
});

it('leaves the journal and serving container intact after a failed repair, then permits retry', async () => {
  const { options, oldContainerId } = await setup();
  const journal = await readUpdateJournal(options.managedRoot);
  const { provisioned, ...expected } = await recoverBackupProvisioning(options);
  expect(provisioned).toBe(false);
  vi.mocked(provisionBackupHost).mockRejectedValueOnce(new Error('provisioning failed'));
  await expect(recoverBackupProvisioning({ ...options, expected })).rejects.toThrow(
    'provisioning failed',
  );
  expect(await readUpdateJournal(options.managedRoot)).toEqual(journal);
  expect((await options.docker.inspectContainer(oldContainerId)).running).toBe(true);
  await expect(recoverBackupProvisioning({ ...options, expected })).resolves.toMatchObject({
    provisioned: true,
  });
});

it('rechecks receipts and does not repeat an already completed host repair', async () => {
  const { options } = await setup();
  const { provisioned, ...expected } = await recoverBackupProvisioning(options);
  expect(provisioned).toBe(false);
  vi.mocked(backupProvisionPlan).mockResolvedValue({ ...plan, provisioned: true });
  await expect(recoverBackupProvisioning({ ...options, expected })).resolves.toMatchObject({
    provisioned: true,
  });
  expect(provisionBackupHost).not.toHaveBeenCalled();
});

it('refuses unavailable provisioning and unreleased target images', async () => {
  const { options } = await setup();
  vi.mocked(backupProvisionPlan).mockResolvedValue(undefined);
  await expect(recoverBackupProvisioning(options)).rejects.toThrow('no release-owned');
  vi.mocked(options.docker.inspectImageEnv!).mockResolvedValue([]);
  await expect(recoverBackupProvisioning(options)).rejects.toThrow('released');
  expect(provisionBackupHost).not.toHaveBeenCalled();
});
