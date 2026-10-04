import type { ProjectRecord, SessionRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';

import {
  AUTOMATION_RUN_EXIT_CODE,
  createAutomationExecutor,
  type AutomationExecutorDeps,
  type AutomationRunInput,
  type AutomationScriptResult,
} from './automation-executor.js';

const session: SessionRecord = {
  sessionId: 's1',
  worktree: '/work/.verity-sessions/s1',
  model: 'm',
  name: null,
  projectId: 'p1',
  lastSeenEventCount: null,
};
const project = { id: 'p1', state: 'active' } as ProjectRecord;

const automation: AutomationRunInput = {
  id: 'a1',
  sessionId: 's1',
  name: 'Morning review',
  prompt: 'Summarize the open pull requests.',
  script: null,
  model: null,
};

function harness(
  overrides: Partial<AutomationExecutorDeps> & {
    script?: AutomationScriptResult;
    noScripts?: true;
  } = {},
) {
  const dispatch = vi.fn(async () => ({ accepted: true }));
  const notice = vi.fn(async () => undefined);
  const runScript = vi.fn(
    async () =>
      overrides.script ?? { exitCode: 0, stdout: 'TOKEN=secret', stderr: '', timedOut: false },
  );
  const { noScripts, ...rest } = overrides;
  delete rest.script;
  const deps: AutomationExecutorDeps = {
    getSession: async (id) => (id === 's1' ? session : undefined),
    getProject: async () => project,
    ...(noScripts ? {} : { runScript }),
    dispatchTurnWhenIdle: dispatch,
    appendNotice: notice,
    ...rest,
  };
  return { executor: createAutomationExecutor(deps), dispatch, notice, runScript };
}

describe('automation executor', () => {
  it('sends a prompt-only automation straight to its session', async () => {
    const { executor, dispatch, runScript } = harness();
    await expect(executor.run(automation)).resolves.toEqual({ outcome: 'acted', detail: null });
    expect(runScript).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('s1', 'Summarize the open pull requests.', {
      validateSession: expect.any(Function),
      displayPrompt: 'Automation · Morning review\n\nSummarize the open pull requests.',
    });
  });

  it('passes the chosen model to the dispatched turn', async () => {
    const { executor, dispatch } = harness();
    await executor.run({ ...automation, model: 'codex/default' });
    expect(dispatch).toHaveBeenCalledWith(
      's1',
      automation.prompt,
      expect.objectContaining({ model: 'codex/default' }),
    );
  });

  it('ends quietly when the check script finds nothing to do', async () => {
    const { executor, dispatch, notice } = harness();
    await expect(executor.run({ ...automation, script: 'exit 0' })).resolves.toEqual({
      outcome: 'ok',
      detail: 'Nothing to do.',
    });
    expect(dispatch).not.toHaveBeenCalled();
    // A quiet slot is the common case for a check; a notice per slot would bury
    // the session's real conversation.
    expect(notice).not.toHaveBeenCalled();
  });

  it('runs the prompt when the check script asks for it', async () => {
    const { executor, dispatch } = harness({
      script: { exitCode: AUTOMATION_RUN_EXIT_CODE, stdout: '', stderr: '', timedOut: false },
    });
    await expect(executor.run({ ...automation, script: 'exit 10' })).resolves.toMatchObject({
      outcome: 'acted',
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('does not execute a claimed script after its automation was paused by a move', async () => {
    const { executor, runScript, dispatch } = harness({
      getSession: async () => ({ ...session, projectId: 'target', worktree: '/target/session' }),
      isCurrent: async () => false,
    });
    await expect(executor.run({ ...automation, script: 'exit 10' })).resolves.toMatchObject({
      outcome: 'skipped',
    });
    expect(runScript).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a workspace change at turn admission after the final check', async () => {
    const { executor } = harness({
      dispatchTurnWhenIdle: async (_id, _prompt, opts) => ({
        accepted: await opts.validateSession({
          ...session,
          projectId: 'target',
          worktree: '/target/session',
        }),
      }),
    });
    await expect(executor.run(automation)).resolves.toMatchObject({ outcome: 'skipped' });
  });

  it('checks an unsaved proposal without requiring a persisted automation claim', async () => {
    const { executor, runScript } = harness({ isCurrent: async () => false });
    await expect(
      executor.checkScript({ ...automation, id: 'check:s1', script: 'exit 0' }),
    ).resolves.toMatchObject({ outcome: 'ok' });
    expect(runScript).toHaveBeenCalledOnce();
  });

  it('does not run a script when its automation changes while waking the project', async () => {
    let current = true;
    const { executor, runScript, dispatch } = harness({
      isCurrent: async () => current,
      prepareProject: async (project) => {
        current = false;
        return project;
      },
    });
    await expect(executor.run({ ...automation, script: 'exit 10' })).resolves.toMatchObject({
      outcome: 'skipped',
    });
    expect(runScript).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch a check result into a workspace that moved during the check', async () => {
    const isCurrent = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { executor, runScript, dispatch } = harness({
      isCurrent,
      script: { exitCode: 10, stdout: '', stderr: '', timedOut: false },
    });
    await expect(executor.run({ ...automation, script: 'exit 10' })).resolves.toMatchObject({
      outcome: 'skipped',
    });
    expect(runScript).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reports a failing check in the session without leaking its output', async () => {
    const { executor, dispatch, notice } = harness({
      script: { exitCode: 2, stdout: 'TOKEN=secret', stderr: 'boom', timedOut: false },
    });
    const result = await executor.run({ ...automation, script: 'exit 2' });
    expect(result).toEqual({ outcome: 'error', detail: 'The check failed with exit code 2.' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(
      's1',
      'Automation “Morning review” could not run. The check failed with exit code 2.',
    );
    expect(JSON.stringify(notice.mock.calls)).not.toContain('secret');
  });

  it('treats a timed-out check as an error', async () => {
    const { executor } = harness({
      script: { exitCode: null, stdout: '', stderr: '', timedOut: true },
    });
    await expect(executor.run({ ...automation, script: 'sleep 999' })).resolves.toMatchObject({
      outcome: 'error',
    });
  });

  it('skips a run while the session is busy instead of steering into it', async () => {
    const { executor, notice } = harness({
      dispatchTurnWhenIdle: async () => ({ accepted: false }),
    });
    await expect(executor.run(automation)).resolves.toEqual({
      outcome: 'skipped',
      detail: 'The session was busy.',
    });
    expect(notice).not.toHaveBeenCalled();
  });

  it('refuses a check script where no container can run it', async () => {
    const { executor } = harness({ noScripts: true });
    await expect(executor.checkScript({ ...automation, script: 'exit 0' })).resolves.toEqual({
      outcome: 'error',
      detail: 'Check scripts are not available on this server.',
    });
  });

  it('refuses a check script in a session without a project', async () => {
    const { executor, runScript } = harness({
      getSession: async () => ({ ...session, projectId: null }),
    });
    await expect(executor.checkScript({ ...automation, script: 'exit 0' })).resolves.toEqual({
      outcome: 'error',
      detail: 'Check scripts need a session in a project.',
    });
    expect(runScript).not.toHaveBeenCalled();
  });

  it('re-checks the model on every run', async () => {
    const isModelAllowed = vi.fn(async () => false);
    const { executor, dispatch } = harness({ isModelAllowed });
    await expect(executor.run({ ...automation, model: 'verity/removed' })).resolves.toEqual({
      outcome: 'error',
      detail: 'The selected model is not available here.',
    });
    expect(isModelAllowed).toHaveBeenCalledWith('verity/removed', session);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('checks a script without ever dispatching a turn', async () => {
    const { executor, dispatch } = harness({
      script: { exitCode: AUTOMATION_RUN_EXIT_CODE, stdout: '', stderr: '', timedOut: false },
    });
    await expect(executor.checkScript({ ...automation, script: 'exit 10' })).resolves.toEqual({
      outcome: 'acted',
      detail: null,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('holds and releases a project activity lease around the script', async () => {
    const end = vi.fn();
    const begin = vi.fn(() => end);
    const { executor } = harness({ beginProjectActivity: begin });
    await executor.run({ ...automation, script: 'exit 0' });
    expect(begin).toHaveBeenCalledWith('p1');
    expect(end).toHaveBeenCalledOnce();
  });

  it('classifies temporary infrastructure errors as skipped', async () => {
    class Sealed extends Error {}
    const { executor } = harness({
      dispatchTurnWhenIdle: async () => {
        throw new Sealed('secret store is sealed');
      },
      isSkippableError: (error) => error instanceof Sealed,
    });
    await expect(executor.run(automation)).resolves.toEqual({
      outcome: 'skipped',
      detail: 'secret store is sealed',
    });
  });
});
