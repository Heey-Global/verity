/** Verity gateway tools behind planning mode. Each backend reports a call under its
 *  own qualified name, so match them with {@link planningToolName}. */
export const START_PLANNING_TOOL = 'verity_start_planning';
export const PRESENT_PLAN_TOOL = 'verity_present_plan';
export const END_PLANNING_TOOL = 'verity_end_planning';

export type PlanningToolName =
  typeof START_PLANNING_TOOL | typeof PRESENT_PLAN_TOOL | typeof END_PLANNING_TOOL;

const PLANNING_TOOLS: readonly PlanningToolName[] = [
  START_PLANNING_TOOL,
  PRESENT_PLAN_TOOL,
  END_PLANNING_TOOL,
];

/** The planning tool a reported tool name refers to: bare (Codex), Claude's
 *  `mcp__verity__…`, or OpenCode's `verity_…`. `undefined` for anything else. */
export function planningToolName(name: string): PlanningToolName | undefined {
  return PLANNING_TOOLS.find(
    (tool) => name === tool || name === `mcp__verity__${tool}` || name === `verity_${tool}`,
  );
}

/** The prompt of the turn that carries out an accepted plan. */
export const IMPLEMENT_PLAN_PROMPT =
  'Planning mode has ended and I accepted the plan. Implement the latest plan you presented.';
/** What the transcript shows for that turn. */
export const IMPLEMENT_PLAN_DISPLAY = 'Implement plan';

/** Sent with every fresh context: when to offer planning and how to start it. */
export const PLANNING_SYSTEM_PROMPT = `# Planning mode (Verity)

Before a materially larger change with real design choices, offer to plan it first: ask with a \`verity:choices\` block whose options include "Plan first" (recommended) and "Implement directly". When the user picks "Plan first", or asks in any wording to plan before implementing, call \`${START_PLANNING_TOOL}\` and then work out the plan without changing any files. Small, clear tasks need no planning.`;

/** Sent with every turn while the session is in planning mode. */
export const PLANNING_ACTIVE_SYSTEM_PROMPT = `# Planning mode is active (Verity)

This session is in planning mode. You cannot change files, and every request for approval is refused. Investigate, ask clarifying questions, and discuss in the chat as usual.

When the plan is complete, or the user asks to see it, submit it with \`${PRESENT_PLAN_TOOL}\` as concise Markdown (goal, steps, open questions or risks) instead of writing it into your reply. Verity shows it with an "Implement plan" button. Submit the whole revised plan the same way whenever it changes. Do not call \`ExitPlanMode\`.

Never start implementing on your own. If the user tells you in the chat to go ahead, call \`${END_PLANNING_TOOL}\`: it asks the user to confirm, and Verity starts the implementation once your turn ends. End your turn right after it returns.`;
