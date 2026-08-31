import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resumeUpdateCutover,
  createUpdateJournalCutoverStore,
  type CutoverPhase,
  type CutoverState,
  type UpdateCutoverDeps,
} from './update-cutover.js';
import { advanceUpdate, beginUpdate } from './update-journal.js';

function fixture(phase: CutoverPhase = 'standby') {
  let state: CutoverState = {
    operationId: 'update-1',
    phase,
    oldGeneration: 4,
    candidateGeneration: 5,
    oldContainerId: 'a'.repeat(64),
    candidateContainerId: 'b'.repeat(64),
  };
  const calls: string[] = [];
  const action = (name: string) => vi.fn(async () => void calls.push(name));
  const deps: UpdateCutoverDeps = {
    store: {
      runExclusive: (run) => run(),
      read: async () => state,
      transition: async (expected, next) => {
        if (state.phase !== expected) throw new Error('phase CAS lost');
        calls.push(`intent:${next}`);
        state = { ...state, phase: next };
        return state;
      },
    },
    quiesceOld: action('quiesce-old'),
    handoffKey: action('handoff-key'),
    activateCandidate: action('activate-candidate'),
    candidateReady: action('candidate-ready'),
    drainGateway: action('drain-gateway'),
    switchGatewayToCandidate: action('switch-candidate'),
    observeCandidate: action('observe-candidate'),
    retireOld: action('retire-old'),
    quiesceCandidate: action('quiesce-candidate'),
    activateOld: action('activate-old'),
    switchGatewayToOld: action('switch-old'),
  };
  return { deps, calls, state: () => state };
}

describe('update cutover orchestration', () => {
  it('persists every intent before its idempotent external action', async () => {
    const run = fixture();
    await expect(resumeUpdateCutover(run.deps)).resolves.toMatchObject({ phase: 'committed' });
    expect(run.calls).toEqual([
      'intent:quiescing-old',
      'quiesce-old',
      'intent:handing-off-key',
      'handoff-key',
      'intent:activating-candidate',
      'activate-candidate',
      'intent:checking-candidate',
      'candidate-ready',
      'intent:draining-gateway',
      'drain-gateway',
      'intent:switching-gateway',
      'switch-candidate',
      'intent:observing-candidate',
      'observe-candidate',
      'intent:committed',
      'retire-old',
    ]);
  });

  it('retires the old container only after commit and retries cleanup from committed', async () => {
    const run = fixture('observing-candidate');
    vi.mocked(run.deps.retireOld).mockRejectedValueOnce(new Error('daemon unavailable'));

    await expect(resumeUpdateCutover(run.deps)).rejects.toThrow('daemon unavailable');
    expect(run.state().phase).toBe('committed');
    expect(run.calls).toEqual(['observe-candidate', 'intent:committed']);

    await expect(resumeUpdateCutover(run.deps)).resolves.toMatchObject({ phase: 'committed' });
    expect(run.calls).toEqual(['observe-candidate', 'intent:committed', 'retire-old']);
  });

  it.each<CutoverPhase>([
    'quiescing-old',
    'handing-off-key',
    'activating-candidate',
    'checking-candidate',
    'draining-gateway',
    'switching-gateway',
    'observing-candidate',
  ])('resumes idempotently from %s', async (phase) => {
    const run = fixture(phase);
    await expect(resumeUpdateCutover(run.deps)).resolves.toMatchObject({ phase: 'committed' });
  });

  it('forward-fences and restores the old generation when readiness fails', async () => {
    const run = fixture();
    vi.mocked(run.deps.candidateReady).mockRejectedValueOnce(new Error('not ready'));
    await expect(resumeUpdateCutover(run.deps)).rejects.toThrow('not ready');
    expect(run.state().phase).toBe('rolled-back');
    expect(run.calls).toContain('intent:rollback-quiescing-candidate');
    expect(run.calls).toContain('quiesce-candidate');
    expect(run.calls).toContain('activate-old');
    expect(run.calls).toContain('switch-old');
  });

  it('resumes a crash in rollback without re-entering cutover', async () => {
    const run = fixture('rollback-activating-old');
    await expect(resumeUpdateCutover(run.deps)).resolves.toMatchObject({ phase: 'rolled-back' });
    expect(run.calls).toEqual([
      'activate-old',
      'intent:rollback-switching-gateway',
      'switch-old',
      'intent:rolled-back',
    ]);
  });

  it('surfaces both the cutover and rollback failure', async () => {
    const run = fixture('checking-candidate');
    vi.mocked(run.deps.candidateReady).mockRejectedValueOnce(new Error('not ready'));
    vi.mocked(run.deps.activateOld).mockRejectedValueOnce(new Error('old failed'));
    await expect(resumeUpdateCutover(run.deps)).rejects.toBeInstanceOf(AggregateError);
    expect(run.state().phase).toBe('rollback-activating-old');
  });

  it('rejects stale or ambiguous generation identities before side effects', async () => {
    const run = fixture();
    Object.assign(run.state(), { candidateGeneration: 4 });
    await expect(resumeUpdateCutover(run.deps)).rejects.toThrow('forward-fence');
    expect(run.calls).toEqual([]);
  });

  it('allows the first cutover from generation zero to generation one', async () => {
    const run = fixture();
    Object.assign(run.state(), { oldGeneration: 0, candidateGeneration: 1 });
    await expect(resumeUpdateCutover(run.deps)).resolves.toMatchObject({ phase: 'committed' });
  });

  it('persists the complete cutover and rollback identities in the updater journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-cutover-journal-'));
    await chmod(root, 0o700);
    await beginUpdate({
      root,
      deploymentId: 'deployment-1',
      idempotencyKey: 'request-1',
      currentGeneration: 4,
      previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
      targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
      randomId: () => 'update-1',
    });
    await advanceUpdate(root, 'requested', 'pulling');
    await advanceUpdate(root, 'pulling', 'verifying-image');
    await advanceUpdate(root, 'verifying-image', 'preflight');
    await advanceUpdate(root, 'preflight', 'creating-standby');
    await advanceUpdate(root, 'creating-standby', 'standby', {
      candidate: { containerId: 'b'.repeat(64), containerName: 'standby-5' },
    });
    const run = fixture();
    const deps = {
      ...run.deps,
      store: createUpdateJournalCutoverStore(root, 'a'.repeat(64)),
    };
    await expect(resumeUpdateCutover(deps)).resolves.toMatchObject({ phase: 'committed' });
    await expect(deps.store.read()).resolves.toMatchObject({
      operationId: 'update-1',
      oldGeneration: 4,
      candidateGeneration: 5,
      oldContainerId: 'a'.repeat(64),
      candidateContainerId: 'b'.repeat(64),
    });
  });

  it('allows only one updater process to resume a journal at a time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-cutover-concurrency-'));
    await chmod(root, 0o700);
    await beginUpdate({
      root,
      deploymentId: 'deployment-1',
      idempotencyKey: 'request-1',
      currentGeneration: 0,
      previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
      targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
      randomId: () => 'update-1',
    });
    await advanceUpdate(root, 'requested', 'pulling');
    await advanceUpdate(root, 'pulling', 'verifying-image');
    await advanceUpdate(root, 'verifying-image', 'preflight');
    await advanceUpdate(root, 'preflight', 'creating-standby');
    await advanceUpdate(root, 'creating-standby', 'standby', {
      candidate: { containerId: 'b'.repeat(64), containerName: 'standby-1' },
    });
    const first = fixture();
    const second = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(first.deps.quiesceOld).mockImplementationOnce(() => gate);
    first.deps = {
      ...first.deps,
      store: createUpdateJournalCutoverStore(root, 'a'.repeat(64)),
    };
    second.deps = {
      ...second.deps,
      store: createUpdateJournalCutoverStore(root, 'a'.repeat(64)),
    };
    const owner = resumeUpdateCutover(first.deps);
    await vi.waitFor(() => expect(first.deps.quiesceOld).toHaveBeenCalledOnce());
    await expect(resumeUpdateCutover(second.deps)).rejects.toThrow('another updater process');
    release();
    await expect(owner).resolves.toMatchObject({ phase: 'committed' });
  });
});
