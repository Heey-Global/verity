import { isSandboxNotReadyError } from '@verity/events';
import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';

import { ensureProjectSandboxReadyForTurn } from './project-auto-wake.js';

const project = (state: ProjectRecord['state']): ProjectRecord =>
  ({ id: 'p1', state }) as ProjectRecord;

describe('project Sandbox automatic wake', () => {
  it('keeps a foreground turn queued until the sleeping project is active', async () => {
    const waitingOn = vi.fn();
    const ensureAwake = vi.fn(async () => project('active'));
    const requestingSessionIds = new Set(['session-1']);

    await expect(
      ensureProjectSandboxReadyForTurn({
        project: project('sleeping'),
        getProject: async () => project('sleeping'),
        canWait: true,
        waitingOn,
        ensureAwake,
        requestingSessionIds,
      }),
    ).resolves.toMatchObject({ state: 'active' });

    expect(waitingOn).toHaveBeenCalledWith(expect.stringContaining('Keeping the turn queued'));
    expect(ensureAwake).toHaveBeenCalledWith('p1', requestingSessionIds);
  });

  it('joins a wake that started before the foreground turn reached readiness', async () => {
    const ensureAwake = vi.fn(async () => project('active'));

    await expect(
      ensureProjectSandboxReadyForTurn({
        project: project('sleeping'),
        getProject: async () => project('waking'),
        canWait: true,
        waitingOn: vi.fn(),
        ensureAwake,
      }),
    ).resolves.toMatchObject({ state: 'active' });

    expect(ensureAwake).toHaveBeenCalledWith('p1', undefined);
  });

  it('keeps background resolution fail-fast instead of waking a project', async () => {
    const ensureAwake = vi.fn(async () => project('active'));

    await expect(
      ensureProjectSandboxReadyForTurn({
        project: project('sleeping'),
        getProject: async () => project('sleeping'),
        canWait: false,
        waitingOn: vi.fn(),
        ensureAwake,
      }),
    ).rejects.toThrow('project Sandbox is sleeping');
    expect(ensureAwake).not.toHaveBeenCalled();
  });

  it('separates a Sandbox that is merely between states from one that needs repair', async () => {
    // Only the transient refusals may be reported as such. Marking `failed` too
    // would hide a project the operator has to go and repair behind an `idle`
    // badge — the session would look finished and nothing would ever say why no
    // turn runs. Marking none of them puts the red badge back on every wake.
    const refusal = async (state: ProjectRecord['state']): Promise<unknown> =>
      await ensureProjectSandboxReadyForTurn({
        project: project(state),
        getProject: async () => project(state),
        canWait: true,
        waitingOn: vi.fn(),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

    // Keyed on the state union rather than a hand-written list of the states that
    // happen to exist today: a ninth `ProjectState` fails to compile here until
    // somebody decides which side of the badge it falls on. Defaulting silently
    // to `crashed` is how this bug got written in the first place.
    const transientRefusal: Record<Exclude<ProjectRecord['state'], 'active'>, boolean> = {
      cloning: true,
      container_starting: true,
      sleeping_starting: true,
      sleeping: true,
      waking: true,
      failed: false,
      absent: false,
    };

    for (const [state, transient] of Object.entries(transientRefusal)) {
      expect(isSandboxNotReadyError(await refusal(state as ProjectRecord['state']))).toBe(
        transient,
      );
    }
  });

  it('reports a wake that ended back in a transient state as transient', async () => {
    // The wake did not throw, it just did not finish — a racing sleep, or another
    // wake still running. Nothing is broken, so this must not badge the session
    // `crashed` either.
    const error = await ensureProjectSandboxReadyForTurn({
      project: project('sleeping'),
      getProject: async () => project('sleeping'),
      canWait: true,
      waitingOn: vi.fn(),
      ensureAwake: async () => project('waking'),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({ message: 'project Sandbox wake ended in waking' });
    expect(isSandboxNotReadyError(error)).toBe(true);
    // A wake that ended in `failed` is a real failure and keeps the red badge.
    const failed = await ensureProjectSandboxReadyForTurn({
      project: project('sleeping'),
      getProject: async () => project('sleeping'),
      canWait: true,
      waitingOn: vi.fn(),
      ensureAwake: async () => project('failed'),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(isSandboxNotReadyError(failed)).toBe(false);
  });
});
