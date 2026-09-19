import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { admitBridgeRecovery } from './bridge-recovery-admission.js';
import {
  adoptedDeployment,
  DEPLOYMENT_ID,
  newImage,
  oldImage,
} from './managed-daemon.test-helper.js';
import { advanceManagedDeploymentImage } from './managed-deployment.js';
import {
  failUpdate,
  readUpdateJournal,
  withUpdateJournalLease,
  type UpdateJournal,
} from './update-journal.js';
import { requestUpdaterOperation, startUpdaterStatusServer } from './updater-status.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function request() {
  const { root } = await adoptedDeployment('verity-bridge-admission');
  roots.push(root);
  return {
    root,
    expectedDeploymentId: DEPLOYMENT_ID,
    expectedImage: oldImage,
    targetDigest: newImage,
    idempotencyKey: 'bridge-request',
  };
}

describe('bridge recovery admission', () => {
  it('hands the reserved journal to the existing two-field API and re-arms retries without another generation', async () => {
    const input = await request();
    const accepted: UpdateJournal[] = [];
    const socketPath = join(input.root, 'control', 'updater.sock');
    const token = 'a'.repeat(32);
    const server = await startUpdaterStatusServer({
      socketPath,
      token,
      managedRoot: input.root,
      onOperationAccepted: (journal) => {
        accepted.push(journal);
      },
    });
    try {
      const reserved = await admitBridgeRecovery(input);
      // The old boundary accepts exactly two request fields. Recovery must wake
      // its executor through that contract without replacing the reserved journal.
      const call = {
        socketPath,
        token,
        targetDigest: input.targetDigest,
        idempotencyKey: input.idempotencyKey,
      };
      const first = await requestUpdaterOperation(call);
      const retry = await requestUpdaterOperation(call);
      expect(first.updateId).toBe(reserved.updateId);
      expect(first.generation).toBe(reserved.generation);
      expect(retry).toEqual(first);
      expect(accepted).toEqual([reserved, reserved]);
      expect(await readUpdateJournal(input.root)).toEqual(reserved);
    } finally {
      await server.close();
    }
  });

  it('reserves the verified predecessor and retries without creating another generation', async () => {
    const input = await request();
    const first = await admitBridgeRecovery(input);
    expect(first).toMatchObject({
      deploymentId: input.expectedDeploymentId,
      previousDigest: input.expectedImage,
      targetDigest: input.targetDigest,
      idempotencyKey: input.idempotencyKey,
      phase: 'requested',
    });
    expect(await admitBridgeRecovery(input)).toEqual(first);
    expect(await readUpdateJournal(input.root)).toEqual(first);
  });

  it('refuses an image changed after verification without reserving an operation', async () => {
    const input = await request();
    await advanceManagedDeploymentImage({
      root: input.root,
      deploymentId: input.expectedDeploymentId,
      fromImage: input.expectedImage,
      toImage: input.targetDigest,
    });
    await expect(admitBridgeRecovery(input)).rejects.toThrow('deployment changed');
    expect(await readUpdateJournal(input.root)).toBeNull();
  });

  it('refuses a different deployment identity', async () => {
    const input = await request();
    await expect(
      admitBridgeRecovery({ ...input, expectedDeploymentId: 'other-deployment' }),
    ).rejects.toThrow('deployment changed');
    expect(await readUpdateJournal(input.root)).toBeNull();
  });

  it('does not replace an in-flight operation or reuse its key for a different target', async () => {
    const input = await request();
    const first = await admitBridgeRecovery(input);
    await expect(
      admitBridgeRecovery({ ...input, idempotencyKey: 'other-request' }),
    ).rejects.toThrow('in progress');
    await expect(
      admitBridgeRecovery({ ...input, targetDigest: newImage.replace(/b{64}$/, 'c'.repeat(64)) }),
    ).rejects.toThrow('different request');
    expect(await readUpdateJournal(input.root)).toEqual(first);
  });

  it('shares the executor lease even on idempotent retries', async () => {
    const input = await request();
    const first = await admitBridgeRecovery(input);
    await withUpdateJournalLease(input.root, async () => {
      await expect(admitBridgeRecovery(input)).rejects.toThrow('owns the update journal');
    });
    expect(await readUpdateJournal(input.root)).toEqual(first);
  });

  it('archives a terminal operation and preserves generation monotonicity', async () => {
    const input = await request();
    const first = await admitBridgeRecovery(input);
    await failUpdate(input.root, 'requested', 'requested-failed');
    const second = await admitBridgeRecovery({ ...input, idempotencyKey: 'second-request' });
    expect(second.generation).toBe(first.generation + 1);
    expect(second.previousDigest).toBe(input.expectedImage);
  });
});
