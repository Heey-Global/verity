import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  advanceCompanionReconciliation,
  advanceCutover,
  advanceUpdate,
  beginUpdate,
  failUpdate,
  type CutoverPhase,
  type UpdateJournal,
} from './update-journal.js';
import {
  parseUpdateOperation,
  projectUpdateOperation,
  isTerminalOperationState,
  type UpdateOperationState,
} from './update-operation.js';

const image = (character: string): string =>
  `ghcr.io/heey-global/verity/verity-server@sha256:${character.repeat(64)}`;
const container = (character: string): string => character.repeat(64);

async function begin(): Promise<{ root: string; journal: UpdateJournal }> {
  const root = await mkdtemp(join(tmpdir(), 'verity-update-operation-'));
  await chmod(root, 0o700);
  const journal = await beginUpdate({
    root,
    deploymentId: 'deployment-1',
    idempotencyKey: 'request-1',
    currentGeneration: 4,
    previousDigest: image('a'),
    targetDigest: image('b'),
    randomId: () => 'update-1',
  });
  return { root, journal };
}

/** Drive the real journal to `standby`, the hand-off point between the plans. */
async function standby(root: string): Promise<UpdateJournal> {
  await advanceUpdate(root, 'requested', 'pulling');
  await advanceUpdate(root, 'pulling', 'verifying-image');
  await advanceUpdate(root, 'verifying-image', 'preflight');
  await advanceUpdate(root, 'preflight', 'creating-standby');
  return advanceUpdate(root, 'creating-standby', 'standby', {
    candidate: { containerId: container('c'), containerName: 'verity-managed-standby-g5' },
  });
}

async function cutover(root: string, path: readonly CutoverPhase[]): Promise<UpdateJournal> {
  let journal = await standby(root);
  let phase: CutoverPhase = 'standby';
  for (const next of path) {
    journal = await advanceCutover(root, phase, next, { previousContainerId: container('d') });
    phase = next;
  }
  return journal;
}

describe('update operation projection', () => {
  it('projects preparation progress without exposing internal identities', async () => {
    const { journal } = await begin();
    const operation = projectUpdateOperation(journal);
    expect(operation).toEqual({
      updateId: 'update-1',
      state: 'preparing',
      phase: 'requested',
      step: 1,
      totalSteps: 16,
      generation: 5,
      previousDigest: image('a'),
      targetDigest: image('b'),
      failureCode: null,
      startedAt: journal.createdAt,
      updatedAt: journal.updatedAt,
    });
    expect(JSON.stringify(operation)).not.toContain('deployment-1');
    expect(JSON.stringify(operation)).not.toContain('request-1');
  });

  it('reports the prepared candidate and hides its container identity', async () => {
    const { root } = await begin();
    const journal = await standby(root);
    const operation = projectUpdateOperation(journal);
    expect(operation).toMatchObject({ state: 'prepared', phase: 'standby', step: 6 });
    expect(JSON.stringify(operation)).not.toContain(container('c'));
    expect(JSON.stringify(operation)).not.toContain('verity-managed-standby-g5');
  });

  it('advances through activation to a completed operation', async () => {
    const { root } = await begin();
    await cutover(root, [
      'quiescing-old',
      'handing-off-key',
      'activating-candidate',
      'checking-candidate',
      'draining-gateway',
      'switching-gateway',
      'observing-candidate',
      'committed',
    ]);
    await advanceCompanionReconciliation(root, 'committed', 'reconciling-companions');
    const journal = await advanceCompanionReconciliation(
      root,
      'reconciling-companions',
      'completed',
    );
    expect(projectUpdateOperation(journal)).toMatchObject({
      state: 'completed',
      phase: 'completed',
      step: 16,
      totalSteps: 16,
    });
  });

  it('counts rollback against the recovery plan, not the update plan', async () => {
    const { root } = await begin();
    const rolling = await cutover(root, [
      'quiescing-old',
      'handing-off-key',
      'rollback-quiescing-candidate',
    ]);
    expect(projectUpdateOperation(rolling)).toMatchObject({
      state: 'rolling-back',
      step: 1,
      totalSteps: 4,
    });
    await advanceCutover(root, 'rollback-quiescing-candidate', 'rollback-activating-old');
    await advanceCutover(root, 'rollback-activating-old', 'rollback-switching-gateway');
    const done = await advanceCutover(root, 'rollback-switching-gateway', 'rolled-back');
    expect(projectUpdateOperation(done)).toMatchObject({
      state: 'rolled-back',
      step: 4,
      totalSteps: 4,
    });
  });

  it('recovers the failed step from the closed failure code', async () => {
    const { root } = await begin();
    await advanceUpdate(root, 'requested', 'pulling');
    await advanceUpdate(root, 'pulling', 'verifying-image');
    const journal = await failUpdate(root, 'verifying-image', 'verifying-image-failed');
    expect(projectUpdateOperation(journal)).toMatchObject({
      state: 'failed',
      phase: 'failed',
      failureCode: 'verifying-image-failed',
      step: 3,
    });
  });

  it('never surfaces an unrecognised failure code to a client', async () => {
    const { root } = await begin();
    const journal = await failUpdate(root, 'requested', 'database.password:hunter2');
    const operation = projectUpdateOperation(journal);
    expect(operation.failureCode).toBe('unknown');
    expect(operation.step).toBe(1);
    expect(JSON.stringify(operation)).not.toContain('hunter2');
  });

  it('marks exactly the outcomes that may be superseded as terminal', () => {
    const states = (...values: readonly UpdateOperationState[]): readonly boolean[] =>
      values.map(isTerminalOperationState);
    expect(states('completed', 'rolled-back', 'failed')).toEqual([true, true, true]);
    expect(states('preparing', 'prepared', 'activating', 'rolling-back')) //
      .toEqual([false, false, false, false]);
  });
});

describe('update operation wire contract', () => {
  const valid = {
    updateId: 'update-1',
    state: 'preparing',
    phase: 'pulling',
    step: 2,
    totalSteps: 16,
    generation: 5,
    previousDigest: image('a'),
    targetDigest: image('b'),
    failureCode: null,
    startedAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:01.000Z',
  };

  it('accepts a projection produced by this build', async () => {
    const { journal } = await begin();
    const operation = projectUpdateOperation(journal);
    expect(parseUpdateOperation(JSON.parse(JSON.stringify(operation)))).toEqual(operation);
  });

  it('rejects payloads that widen or contradict the contract', () => {
    expect(parseUpdateOperation(valid)).toEqual(valid);
    expect(parseUpdateOperation({ ...valid, extra: 1 })).toBeNull();
    expect(parseUpdateOperation({ ...valid, state: 'prepared' })).toBeNull();
    expect(parseUpdateOperation({ ...valid, step: 0 })).toBeNull();
    expect(parseUpdateOperation({ ...valid, step: 15 })).toBeNull();
    expect(parseUpdateOperation({ ...valid, totalSteps: 4 })).toBeNull();
    expect(parseUpdateOperation({ ...valid, generation: 0 })).toBeNull();
    expect(
      parseUpdateOperation({ ...valid, targetDigest: 'ghcr.io/other/image:latest' }),
    ).toBeNull();
    expect(parseUpdateOperation({ ...valid, updatedAt: 'yesterday' })).toBeNull();
    expect(parseUpdateOperation({ ...valid, failureCode: 'boom' })).toBeNull();
    expect(parseUpdateOperation({ ...valid, failureCode: 'pulling-failed' })).toBeNull();
    expect(
      parseUpdateOperation({
        ...valid,
        state: 'failed',
        phase: 'failed',
        failureCode: 'pulling-failed',
      }),
    ).toMatchObject({ state: 'failed', failureCode: 'pulling-failed' });
    expect(parseUpdateOperation({ ...valid, state: 'rolling-back', phase: 'pulling' })).toBeNull();
    // `failed` is a state and a phase, and neither may appear without the other.
    expect(parseUpdateOperation({ ...valid, phase: 'failed', step: 1 })).toBeNull();
    expect(parseUpdateOperation({ ...valid, state: 'failed', failureCode: 'pulling-failed' })) //
      .toBeNull();
    // A step the phase does not support would show progress that never happened.
    expect(parseUpdateOperation({ ...valid, step: 3 })).toBeNull();
    expect(
      parseUpdateOperation({
        ...valid,
        state: 'preparing',
        phase: 'requested',
        step: 14,
      }),
    ).toBeNull();
  });
});
