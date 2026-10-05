import type { ToolCall } from '../happy/message.js';

/**
 * The agent's task list, read off a `TodoWrite` call. ACP agents report their
 * plan as a separate notification that the session adapter carries as such a
 * call (see `PLAN_TOOL_NAME` in `@verity/session`); Claude's own `TodoWrite`
 * input has the same `todos` shape, so both render as one checklist.
 */
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
}

export interface PlanView {
  entries: PlanEntry[];
  completed: number;
  /** The entry being worked on, for the collapsed line; null when none is. */
  current: string | null;
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

/** The checklist a call carries, or null when it is not a plan, its input does
 * not have the expected shape, or the call failed and the list never took effect
 * — the caller then renders an ordinary tool card. */
export function planView(tool: ToolCall): PlanView | null {
  if (tool.name !== 'TodoWrite' || tool.state === 'error') return null;
  const input = tool.input;
  if (typeof input !== 'object' || input === null) return null;
  const todos = (input as Record<string, unknown>).todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const entries: PlanEntry[] = [];
  for (const todo of todos) {
    if (typeof todo !== 'object' || todo === null) return null;
    const { content, status } = todo as Record<string, unknown>;
    if (typeof content !== 'string' || typeof status !== 'string' || !STATUSES.has(status)) {
      return null;
    }
    entries.push({ content, status: status as PlanEntryStatus });
  }
  return {
    entries,
    completed: entries.filter((entry) => entry.status === 'completed').length,
    current: entries.find((entry) => entry.status === 'in_progress')?.content ?? null,
  };
}

/** "Plan · 2 of 5 done" — the card's headline. */
export function planHeadline(plan: PlanView): string {
  return `Plan · ${String(plan.completed)} of ${String(plan.entries.length)} done`;
}
