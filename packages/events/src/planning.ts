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

This session is in planning mode, started after the user chose to plan first. You cannot change files or use external tools (mail, calendar, Drive, secrets and the like); the Verity task list stays available. Investigate, ask clarifying questions, and discuss in the chat as usual.

When the plan is complete, or the user asks to see it, submit it with \`${PRESENT_PLAN_TOOL}\`. Never write the plan into your reply: Verity shows a submitted plan as its own card above the composer with "Implement" and "Dismiss" buttons, while a plan in the reply is plain chat text that cannot be implemented. Resolve open questions in the chat before presenting the plan. Structure the plan as Markdown in this shape:

\`\`\`markdown
# Short plan title

## Goal
One sentence.

## Steps
1. **Short step title** — one line on what changes and where.

\`\`\`

Keep each step to one line and the whole plan scannable on a phone. After submitting, end your turn without repeating the plan or explaining the buttons. Submit the whole revised plan again whenever it changes. Do not add a \`verity:choices\` block to ask whether to implement the plan, since the card's button already asks that, and do not call \`ExitPlanMode\`.

Never start implementing on your own. If the user tells you in the chat to go ahead, call \`${END_PLANNING_TOOL}\` (after submitting the plan, if you have not yet): their message already authorizes implementation; no extra confirmation is needed. Verity starts implementation once your turn ends. End your turn right after it returns. If the user wants to leave planning without a plan, call the same tool with action "discard"; it asks once before restoring file access. Do not create tasks for unaccepted proposal steps. Accepted steps are saved automatically as assigned tasks; update those existing tasks instead of creating duplicates.`;

/** Shared by the proposal card and task persistence: only numbered steps in the
 * Steps section become accepted tasks, never numbered questions or risks. */
export function parsePlanningProposal(markdown: string): {
  title: string;
  goal: string;
  steps: string[];
} {
  const lines = markdown.trim().split('\n');
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  const title = titleIndex >= 0 ? lines[titleIndex]!.replace(/^#\s+/, '').trim() : '';
  const goal: string[] = [];
  const steps: string[] = [];
  const hasStepsHeading = lines.some((line) => /^#{1,6}\s+steps\b/i.test(line.trim()));
  let section = 'goal';
  for (const [index, line] of lines.entries()) {
    if (index === titleIndex) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (heading) {
      section = /^steps\b/i.test(heading[1]!)
        ? 'steps'
        : /^goal\b/i.test(heading[1]!)
          ? 'goal'
          : 'other';
      continue;
    }
    const step = /^\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (step && (section === 'steps' || (!hasStepsHeading && section === 'goal'))) {
      steps.push(step[1]!.trim());
    } else if (section === 'steps' && line.trim() && steps.length > 0) {
      steps[steps.length - 1] += `\n${line.trim()}`;
    } else if (section === 'goal') {
      goal.push(line);
    }
  }
  return { title, goal: goal.join('\n').trim(), steps };
}

export const DISMISSED_PLAN_SYSTEM_PROMPT =
  'The user dismissed the plan. Keep it as context, but do not implement it unless the user asks.';
