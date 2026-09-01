import type { AgentLoopRecord, ProjectRecord, SessionRecord } from '@verity/store';
import { appendExternalPromptData } from '@verity/events';

interface AgentLoopScriptResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface AgentLoopExecutionResult {
  outcome: 'ok' | 'acted' | 'error' | 'skipped';
  exitCode: number | null;
  detail: string | null;
  sessionId: string | null;
}

export interface AgentLoopExecutorDeps {
  ensureSession(loop: AgentLoopRecord, project: ProjectRecord): Promise<SessionRecord>;
  runScript(input: {
    loop: AgentLoopRecord;
    project: ProjectRecord;
    session: SessionRecord;
  }): Promise<AgentLoopScriptResult>;
  appendNotice(sessionId: string, text: string): Promise<void>;
  dispatchTurnWhenIdle(
    sessionId: string,
    prompt: string,
    model?: string,
  ): Promise<{ accepted: boolean }>;
  /** Project loop sessions currently route only to Claude and Codex. */
  isModelAllowed?(model: string): boolean;
  /** Classify temporary infrastructure state (for example a sealed secret
   * store) as a skipped scheduled run rather than a circuit-breaking failure. */
  isSkippableError?(error: unknown): boolean;
}

export interface AgentLoopExecutor {
  execute(
    loop: AgentLoopRecord,
    project: ProjectRecord,
    opts?: { test?: boolean },
  ): Promise<AgentLoopExecutionResult>;
}

const SPAWN_EXIT_CODE = 10;

/** Shared execution core for scheduled and test runs. The in-memory lock closes
 * the route-vs-scheduler race within one server process. The scheduler's DB
 * claim remains the restart-safe protection for scheduled ticks. */
export function createAgentLoopExecutor(deps: AgentLoopExecutorDeps): AgentLoopExecutor {
  const running = new Set<string>();
  return {
    async execute(loop, project, opts = {}) {
      if (running.has(loop.id)) {
        return {
          outcome: 'skipped',
          exitCode: null,
          detail: 'Agent Loop is already running',
          sessionId: loop.sessionId,
        };
      }
      running.add(loop.id);
      try {
        if (!loop.script?.trim()) {
          return {
            outcome: 'error',
            exitCode: null,
            detail: 'Agent Loop has no script',
            sessionId: loop.sessionId,
          };
        }
        const session = await deps.ensureSession(loop, project);
        const result = await deps.runScript({ loop, project, session });
        const signal = parseSpawnSignal(result.stdout);
        // stdout/stderr may contain repository data. Never persist raw process
        // output in notices or run history; only an explicit JSON `prompt` crosses
        // into the agent turn. This keeps accidental `env`/`.env` output out of the
        // durable transcript.
        const finish = async (
          outcome: AgentLoopExecutionResult['outcome'],
          exitCode: number | null,
          detail: string | null,
        ): Promise<AgentLoopExecutionResult> => {
          await deps.appendNotice(
            session.sessionId,
            `${opts.test ? 'Agent Loop test' : 'Agent Loop run'} · ${outcome}${detail ? `\n\n${detail}` : ''}`,
          );
          return settled(outcome, exitCode, detail, session.sessionId);
        };

        if (result.timedOut) {
          return finish('error', result.exitCode, 'Script timed out');
        }
        if (signal.error) {
          return finish('error', result.exitCode, signal.error);
        }
        const shouldAct = signal.spawn || result.exitCode === SPAWN_EXIT_CODE;
        if (!shouldAct && result.exitCode !== 0) {
          return finish(
            'error',
            result.exitCode,
            `Script failed with exit code ${String(result.exitCode)}`,
          );
        }
        if (!shouldAct) return finish('ok', result.exitCode, null);

        if (signal.prompt !== undefined && signal.prompt.trim().length === 0) {
          return finish('error', result.exitCode, 'Spawn signal needs a prompt');
        }
        const prompt =
          signal.prompt === undefined
            ? loop.reactionPrompt
            : appendExternalPromptData(
                'Evaluate the Agent Loop finding and take the smallest appropriate action for this repository.',
                `Agent Loop script ${loop.id}`,
                { requestedAction: signal.prompt },
              );
        if (!prompt?.trim()) {
          return finish('error', result.exitCode, 'Spawn signal needs a prompt');
        }
        const model = signal.model ?? loop.reactionModel ?? undefined;
        if (model && deps.isModelAllowed?.(model) === false) {
          return finish('error', result.exitCode, 'Agent Loop requested an unsupported model');
        }
        // A test proves the complete contract but never spends tokens or triggers work.
        if (opts.test) return finish('acted', result.exitCode, 'Agent action requested');
        const { accepted } = await deps.dispatchTurnWhenIdle(session.sessionId, prompt, model);
        if (!accepted) {
          return finish('skipped', result.exitCode, 'Loop session is busy');
        }
        return finish('acted', result.exitCode, 'Agent action requested');
      } catch (error) {
        if (deps.isSkippableError?.(error) === true) {
          return settled(
            opts.test ? 'error' : 'skipped',
            null,
            error instanceof Error ? error.message : String(error),
            loop.sessionId,
          );
        }
        return settled(
          'error',
          null,
          error instanceof Error ? error.message : String(error),
          loop.sessionId,
        );
      } finally {
        running.delete(loop.id);
      }
    },
  };
}

function settled(
  outcome: AgentLoopExecutionResult['outcome'],
  exitCode: number | null,
  detail: string | null,
  sessionId: string | null,
): AgentLoopExecutionResult {
  return { outcome, exitCode, detail, sessionId };
}

function parseSpawnSignal(stdout: string): {
  spawn: boolean;
  prompt?: string;
  model?: string;
  error?: string;
} {
  const candidates = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (const line of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null || !('spawn' in value)) continue;
    const record = value as Record<string, unknown>;
    if (record['spawn'] !== true && record['spawn'] !== false) {
      return { spawn: false, error: 'Spawn signal must use a boolean `spawn` field' };
    }
    if (record['prompt'] !== undefined && typeof record['prompt'] !== 'string') {
      return { spawn: false, error: 'Spawn signal `prompt` must be a string' };
    }
    if (record['model'] !== undefined && typeof record['model'] !== 'string') {
      return { spawn: false, error: 'Spawn signal `model` must be a string' };
    }
    return {
      spawn: record['spawn'],
      ...(typeof record['prompt'] === 'string' ? { prompt: record['prompt'] } : {}),
      ...(typeof record['model'] === 'string' ? { model: record['model'] } : {}),
    };
  }
  return { spawn: false };
}
