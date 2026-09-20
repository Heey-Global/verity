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
});
