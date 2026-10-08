import { PRESENT_PLAN_TOOL, planningToolName, parsePlanningProposal } from '@verity/events';

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

/**
 * The Markdown plan a call presents for the operator's decision, or null when it
 * presents none. Two sources: Verity's `verity_present_plan` gateway tool, which
 * every agent uses in planning mode, and Claude's own `ExitPlanMode`, which Claude
 * may still call there — refused, but its plan is the same plan. A presentation
 * the gateway refused (outside planning mode) never reached the operator.
 */
export function planProposal(tool: ToolCall): string | null {
  const presented = planningToolName(tool.name) === PRESENT_PLAN_TOOL;
  if (!presented && tool.name !== 'ExitPlanMode') return null;
  if (presented && tool.state !== 'completed') return null;
  const plan = record(record(tool.input)?.arguments)?.plan ?? record(tool.input)?.plan;
  return typeof plan === 'string' && plan.trim() !== '' ? plan : null;
}

/** Codex reports an MCP call's input as `{ server, tool, arguments }`; the other
 *  agents report the arguments themselves. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The revision belongs to this successful presentation, never to a later poll. */
export function planProposalRevision(tool: ToolCall): number | undefined {
  if (planningToolName(tool.name) !== PRESENT_PLAN_TOOL || tool.state !== 'completed')
    return undefined;
  const extract = (value: unknown): number | undefined => {
    const object = record(value);
    const revision = object?.planningRevision;
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0)
      return revision;
    if (object?.structuredContent !== undefined) return extract(object.structuredContent);
    const content = object?.content ?? (Array.isArray(value) ? value : undefined);
    if (Array.isArray(content)) {
      for (const item of content) {
        const text = record(item)?.text;
        if (typeof text !== 'string') continue;
        try {
          const found = extract(JSON.parse(text));
          if (found !== undefined) return found;
        } catch {
          /* Non-JSON tool text carries no revision. */
        }
      }
    }
    return undefined;
  };
  return extract(tool.result);
}

/** Keep the text and approval revision from the same snapshot. */
export function planProposalDisplay(
  presented: { markdown: string; revision?: number },
  latest: boolean,
  current: { planningPlan?: string | null; planningRevision?: number } | null,
): { markdown: string; revision: number | undefined } {
  if (
    latest &&
    current?.planningPlan != null &&
    current.planningRevision !== undefined &&
    (presented.revision === undefined || current.planningRevision >= presented.revision)
  ) {
    return { markdown: current.planningPlan, revision: current.planningRevision };
  }
  return { markdown: presented.markdown, revision: presented.revision };
}

/** The count uses the same parser as the card and implementation tasks. */
export function planProposalHeadline(markdown: string): string {
  const steps = parsePlanningProposal(markdown).steps.length;
  if (steps === 0) return 'Plan';
  return `Plan · ${String(steps)} ${steps === 1 ? 'step' : 'steps'}`;
}

/** The pinned card and server-created tasks share the proposal's structure. */
export const planProposalContent = parsePlanningProposal;
