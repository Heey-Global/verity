import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { advanceUpdate, beginUpdate, readUpdateJournal } from './update-journal.js';
import { resumeUpdatePreparation } from './update-preparation.js';

const image = (character: string): string =>
  `ghcr.io/heey-global/verity/verity-server@sha256:${character.repeat(64)}`;
async function operation(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verity-update-preparation-'));
  await chmod(root, 0o700);
  await beginUpdate({
    root,
    deploymentId: 'deployment-1',
    idempotencyKey: 'request-1',
    currentGeneration: 1,
    previousDigest: image('a'),
    targetDigest: image('b'),
    randomId: () => 'update-1',
    now: () => new Date('2026-08-09T00:00:00.000Z'),
  });
  return root;
}
function deps() {
  return {
    pullImage: vi.fn(async () => undefined),
    verifyImage: vi.fn(async () => undefined),
    runPreflight: vi.fn(async () => undefined),
    prepareStandby: vi.fn(async () => undefined),
    ensureStandby: vi.fn(async () => ({
      containerId: 'c'.repeat(64),
      containerName: 'verity-standby-update-1',
    })),
    now: vi.fn(() => new Date('2026-08-09T00:00:01.000Z')),
  };
}

describe('update preparation recovery', () => {
  it('journals intent before every action and reaches a non-routed standby', async () => {
    const root = await operation();
    const actions = deps();
    await expect(resumeUpdatePreparation(root, actions)).resolves.toMatchObject({
      phase: 'standby',
      candidate: {
        containerId: 'c'.repeat(64),
        containerName: 'verity-standby-update-1',
      },
    });
    expect(actions.pullImage).toHaveBeenCalledWith(image('b'));
    expect(actions.verifyImage).toHaveBeenCalledTimes(1);
    expect(actions.runPreflight).toHaveBeenCalledTimes(1);
    expect(actions.prepareStandby).toHaveBeenCalledTimes(1);
    expect(actions.ensureStandby).toHaveBeenCalledTimes(1);
  });

  it('resumes each durable intent phase without replaying completed phases', async () => {
    const phases = ['pulling', 'verifying-image', 'preflight', 'creating-standby'] as const;
    for (const phase of phases) {
      const root = await operation();
      await advanceUpdate(root, 'requested', 'pulling');
      if (phase !== 'pulling') await advanceUpdate(root, 'pulling', 'verifying-image');
      if (phase === 'preflight' || phase === 'creating-standby')
        await advanceUpdate(root, 'verifying-image', 'preflight');
      if (phase === 'creating-standby') await advanceUpdate(root, 'preflight', 'creating-standby');
      const resumed = deps();
      await expect(resumeUpdatePreparation(root, resumed)).resolves.toMatchObject({
        phase: 'standby',
      });
      expect(resumed.pullImage).toHaveBeenCalledTimes(phase === 'pulling' ? 1 : 0);
      expect(resumed.verifyImage).toHaveBeenCalledTimes(
        phase === 'preflight' || phase === 'creating-standby' ? 0 : 1,
      );
      expect(resumed.runPreflight).toHaveBeenCalledTimes(phase === 'creating-standby' ? 0 : 1);
      expect(resumed.prepareStandby).toHaveBeenCalledTimes(1);
    }
  });

  it('reconciles a candidate again after a crash between create and standby journal write', async () => {
    const root = await operation();
    await advanceUpdate(root, 'requested', 'pulling');
    await advanceUpdate(root, 'pulling', 'verifying-image');
    await advanceUpdate(root, 'verifying-image', 'preflight');
    await advanceUpdate(root, 'preflight', 'creating-standby');
    const resumed = deps();
    await expect(resumeUpdatePreparation(root, resumed)).resolves.toMatchObject({
      phase: 'standby',
    });
    expect(resumed.ensureStandby).toHaveBeenCalledTimes(1);
    expect(resumed.pullImage).not.toHaveBeenCalled();
  });

  it('returns terminal standby or failed state without any external action', async () => {
    const root = await operation();
    const actions = deps();
    await resumeUpdatePreparation(root, actions);
    const again = deps();
    await expect(resumeUpdatePreparation(root, again)).resolves.toMatchObject({ phase: 'standby' });
    expect(again.pullImage).not.toHaveBeenCalled();
    expect(again.ensureStandby).not.toHaveBeenCalled();
  });

  it('records a bounded phase code without persisting an external error message', async () => {
    const root = await operation();
    const actions = deps();
    actions.verifyImage.mockRejectedValueOnce(new Error('credential-shaped sensitive detail'));
    await expect(resumeUpdatePreparation(root, actions)).rejects.toThrow(/sensitive detail/);
    const journal = await readUpdateJournal(root);
    expect(journal).toMatchObject({
      phase: 'failed',
      failure: { code: 'verifying-image-failed' },
    });
    expect(JSON.stringify(journal)).not.toContain('sensitive detail');
  });

  it('keeps standby preparation resumable after durable authority migration', async () => {
    const root = await operation();
    const first = deps();
    first.ensureStandby.mockRejectedValueOnce(new Error('temporary Docker failure'));
    await expect(resumeUpdatePreparation(root, first)).rejects.toThrow(/temporary Docker failure/);
    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'creating-standby' });

    const resumed = deps();
    await expect(resumeUpdatePreparation(root, resumed)).resolves.toMatchObject({
      phase: 'standby',
    });
    expect(resumed.pullImage).not.toHaveBeenCalled();
    expect(resumed.runPreflight).not.toHaveBeenCalled();
    expect(resumed.prepareStandby).toHaveBeenCalledTimes(1);
    expect(resumed.ensureStandby).toHaveBeenCalledTimes(1);
  });

  it('rejects a concurrent preparation worker while the kernel lease is held', async () => {
    const root = await operation();
    let release!: () => void;
    const blocked = deps();
    blocked.pullImage.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    const first = resumeUpdatePreparation(root, blocked);
    await vi.waitFor(() => expect(blocked.pullImage).toHaveBeenCalledTimes(1));
    await expect(resumeUpdatePreparation(root, deps())).rejects.toThrow(/another updater process/);
    release();
    await expect(first).resolves.toMatchObject({ phase: 'standby' });
  });
});
