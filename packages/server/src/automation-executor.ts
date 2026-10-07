// Runs one session automation: optionally a check script in the project
// container, then the automation's prompt as a standalone turn in its session.
// Shared by scheduled runs and by the one-off script check performed when the
// operator confirms an automation that has a script.
import type { ProjectRecord, SessionAutomationRecord, SessionRecord } from '@verity/store';

type AutomationRunOutcome = 'ok' | 'acted' | 'error' | 'skipped';

export interface AutomationRunResult {
  outcome: AutomationRunOutcome;
  /** Short operator-facing sentence; never raw script output. */
  detail: string | null;
}

export interface AutomationScriptResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The part of an automation a run needs. A confirmation check runs before the
 * automation exists, so it cannot require a persisted record. */
export type AutomationRunInput = Pick<
  SessionAutomationRecord,
  'id' | 'sessionId' | 'name' | 'prompt' | 'script' | 'model'
> &
  Partial<Pick<SessionAutomationRecord, 'sponsorUserId'>>;

export interface AutomationExecutorDeps {
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  getProject(projectId: string): Promise<ProjectRecord | undefined>;
  /** A claim can outlive a pause, replacement, or move. Confirm it still belongs
   * to this workspace before a script or its resulting prompt is dispatched. */
  isCurrent?(automation: AutomationRunInput, session: SessionRecord): Promise<boolean>;
  /** Wake or otherwise prepare the project before a check script runs. */
  prepareProject?(project: ProjectRecord): Promise<ProjectRecord>;
  /** Hold an activity lease while the script uses the project Sandbox. */
  beginProjectActivity?(projectId: string): (() => void) | undefined;
  /** Absent where no project container can run scripts. */
  runScript?(input: {
    script: string;
    project: ProjectRecord;
    session: SessionRecord;
  }): Promise<AutomationScriptResult>;
  dispatchTurnWhenIdle(
    sessionId: string,
    prompt: string,
    opts: {
      model?: string;
      displayPrompt: string;
      validateSession: (session: SessionRecord) => Promise<boolean>;
      /** The automation's sponsor, who the turn runs for and notifies. */
      initiatedBy?: { userId: string };
    },
  ): Promise<{ accepted: boolean }>;
  appendNotice(sessionId: string, text: string): Promise<void>;
  /** Re-checked on every run: settings can change after the operator confirmed. */
  isModelAllowed?(model: string, session: SessionRecord): Promise<boolean> | boolean;
  /** Temporary infrastructure state (for example a sealed secret store) skips a
   * scheduled run instead of counting toward the error pause. */
  isSkippableError?(error: unknown): boolean;
}

export interface AutomationExecutor {
  /** A scheduled run: dispatches the prompt when due and records failures in
   * the session so the operator sees why nothing happened. */
  run(automation: AutomationRunInput): Promise<AutomationRunResult>;
  /** Run only the check script, to prove it works before it is saved. */
  checkScript(automation: AutomationRunInput): Promise<AutomationRunResult>;
}

/** Exit code a check script uses to ask for the prompt to run. */
export const AUTOMATION_RUN_EXIT_CODE = 10;

export function createAutomationExecutor(deps: AutomationExecutorDeps): AutomationExecutor {
  const running = new Set<string>();

  const scriptVerdict = async (
    script: string,
    session: SessionRecord,
    automation: AutomationRunInput,
    scheduled: boolean,
  ): Promise<AutomationRunResult | 'run'> => {
    if (!deps.runScript) {
      return { outcome: 'error', detail: 'Check scripts are not available on this server.' };
    }
    if (session.projectId === null) {
      return { outcome: 'error', detail: 'Check scripts need a session in a project.' };
    }
    const found = await deps.getProject(session.projectId);
    if (!found) return { outcome: 'error', detail: 'The project no longer exists.' };
    const project = (await deps.prepareProject?.(found)) ?? found;
    const endActivity = deps.beginProjectActivity?.(project.id);
    if (deps.beginProjectActivity !== undefined && endActivity === undefined) {
      return { outcome: 'skipped', detail: 'The project workspace was busy.' };
    }
    try {
      const currentSession = await deps.getSession(session.sessionId);
      if (
        !currentSession ||
        currentSession.projectId !== session.projectId ||
        currentSession.worktree !== session.worktree ||
        (scheduled && (await deps.isCurrent?.(automation, session)) === false)
      ) {
        return { outcome: 'skipped', detail: 'The automation or its workspace changed.' };
      }
      // stdout/stderr may contain repository data or credentials; only the exit
      // code crosses into history, notices, or the agent's turn.
      const result = await deps.runScript({ script, project, session });
      if (result.timedOut) return { outcome: 'error', detail: 'The check timed out.' };
      if (result.exitCode === 0) return { outcome: 'ok', detail: 'Nothing to do.' };
      if (result.exitCode === AUTOMATION_RUN_EXIT_CODE) return 'run';
      return {
        outcome: 'error',
        detail: `The check failed with exit code ${String(result.exitCode)}.`,
      };
    } finally {
      endActivity?.();
    }
  };

  const guarded = async (
    automation: AutomationRunInput,
    body: () => Promise<AutomationRunResult>,
  ): Promise<AutomationRunResult> => {
    if (running.has(automation.id)) {
      return { outcome: 'skipped', detail: 'The previous run is still in progress.' };
    }
    running.add(automation.id);
    try {
      return await body();
    } catch (error) {
      if (deps.isSkippableError?.(error) === true) {
        return { outcome: 'skipped', detail: errorMessage(error) };
      }
      return { outcome: 'error', detail: errorMessage(error) };
    } finally {
      running.delete(automation.id);
    }
  };

  const loadSession = async (sessionId: string): Promise<SessionRecord> => {
    const session = await deps.getSession(sessionId);
    if (!session) throw new Error('The session no longer exists.');
    return session;
  };

  return {
    async run(automation) {
      const result = await guarded(automation, async () => {
        const session = await loadSession(automation.sessionId);
        if ((await deps.isCurrent?.(automation, session)) === false) {
          return { outcome: 'skipped', detail: 'The automation or its workspace changed.' };
        }
        if (automation.script !== null) {
          const verdict = await scriptVerdict(automation.script, session, automation, true);
          if (verdict !== 'run') return verdict;
        }
        if (
          automation.model !== null &&
          (await deps.isModelAllowed?.(automation.model, session)) === false
        ) {
          return { outcome: 'error', detail: 'The selected model is not available here.' };
        }
        if ((await deps.isCurrent?.(automation, session)) === false) {
          return { outcome: 'skipped', detail: 'The automation or its workspace changed.' };
        }
        const { accepted } = await deps.dispatchTurnWhenIdle(session.sessionId, automation.prompt, {
          ...(automation.model !== null ? { model: automation.model } : {}),
          validateSession: async (acceptedSession) =>
            acceptedSession.projectId === session.projectId &&
            acceptedSession.worktree === session.worktree &&
            (await deps.isCurrent?.(automation, acceptedSession)) !== false,
          displayPrompt: `Automation · ${automation.name}\n\n${automation.prompt}`,
          ...(automation.sponsorUserId
            ? { initiatedBy: { userId: automation.sponsorUserId } }
            : {}),
        });
        return accepted
          ? { outcome: 'acted', detail: null }
          : { outcome: 'skipped', detail: 'The session was busy.' };
      });
      if (result.outcome === 'error') {
        await deps
          .appendNotice(
            automation.sessionId,
            `Automation “${automation.name}” could not run. ${result.detail ?? ''}`.trim(),
          )
          .catch(() => undefined);
      }
      return result;
    },

    async checkScript(automation) {
      return guarded(automation, async () => {
        if (automation.script === null) return { outcome: 'ok', detail: null };
        const session = await loadSession(automation.sessionId);
        const verdict = await scriptVerdict(automation.script, session, automation, false);
        return verdict === 'run' ? { outcome: 'acted', detail: null } : verdict;
      });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
