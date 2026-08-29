import type { SessionSummary } from '../api.js';

/**
 * The human label for a session (pure → unit-testable): the operator-assigned
 * name when set, else the worktree (its branch identity), else the raw session
 * id as a last resort. Used by the home list and the in-session switcher so both
 * name a session the same way.
 */
export function sessionLabel(
  session: Pick<SessionSummary, 'name' | 'worktree' | 'sessionId'>,
): string {
  return session.name?.trim() || worktreeLabel(session.worktree) || session.sessionId;
}

function worktreeLabel(worktree: string): string | undefined {
  const trimmed = worktree.trim();
  if (!trimmed) return undefined;
  const tail = trimmed.split(/[\\/]/).filter(Boolean).at(-1);
  if (!tail) return undefined;
  if (tail.startsWith('agent-'))
    return `Session ${tail.slice('agent-'.length, 'agent-'.length + 8)}`;
  return tail;
}
