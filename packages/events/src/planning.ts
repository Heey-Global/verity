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
  const canonical = name.replace(/^mcp__verity__/u, '').replace(/^verity_verity_/u, 'verity_');
  const aliases: Record<string, PlanningToolName> = {
    verity_planning_start: START_PLANNING_TOOL,
    verity_planning_present: PRESENT_PLAN_TOOL,
    verity_planning_implement: END_PLANNING_TOOL,
    verity_planning_discard: END_PLANNING_TOOL,
  };
  if (Object.hasOwn(aliases, canonical)) return aliases[canonical];
  return PLANNING_TOOLS.find(
    (tool) => name === tool || name === `mcp__verity__${tool}` || name === `verity_${tool}`,
  );
}

/** Presents rendered mockups for review; outside planning mode, after a plan with a
 *  Mockups section was accepted. */
export const PRESENT_MOCKUPS_TOOL = 'verity_present_mockups';

/** The focused name agents see for {@link PRESENT_MOCKUPS_TOOL}. */
export const PRESENT_MOCKUPS_FOCUSED_TOOL = 'verity_mockups_present';

/** Whether a reported tool name presents mockups, under any backend's qualification
 *  (bare for Codex, `mcp__verity__…` for Claude, `verity_…` for OpenCode) and under
 *  either its gateway or its focused name. */
export function isPresentMockupsTool(name: string): boolean {
  const canonical = name.replace(/^mcp__verity__/u, '').replace(/^verity_verity_/u, 'verity_');
  return canonical === PRESENT_MOCKUPS_TOOL || canonical === PRESENT_MOCKUPS_FOCUSED_TOOL;
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

When the plan is complete, or the user asks to see it, submit it with \`${PRESENT_PLAN_TOOL}\`. Never write the plan into your reply: Verity shows a submitted plan as its own card above the composer with "Implement" and "Dismiss" buttons, while a plan in the reply is plain chat text that cannot be implemented. Resolve open questions in the chat before presenting the plan where you can. Structure the plan as Markdown in this shape; Goal and Steps are required, the other sections are included when they have content:

\`\`\`markdown
# Short plan title

## Goal
One sentence.

## Out of scope
What the plan deliberately leaves out, in one or two lines.

## Acceptance criteria
- One observable result the work must satisfy; the implementation is checked against these.

## Open decisions
1. **Question for the user?** — Option A (recommended) | Option B

## Mockups
- **Screen name** — what the mockup shows.

## Steps
1. **Short step title** — one line on what changes and where.

\`\`\`

Include Mockups only when the note returned by \`${START_PLANNING_TOOL}\` asks for it or the user wants mockups: list each screen to mock up. Planned mockups are built and approved before the rest of the implementation starts.

Keep each step, criterion and decision to one line and the whole plan scannable on a phone. List under Open decisions only choices that need the user's answer; the card shows each as tappable options, marks the recommended one, and blocks implementation until no decision is left. When the user answers, apply the answer and present the revised plan without that decision. After submitting, end your turn without repeating the plan or explaining the buttons. Submit the whole revised plan again whenever it changes. Do not add a \`verity:choices\` block to ask whether to implement the plan, since the card's button already asks that, and do not call \`ExitPlanMode\`.

Never start implementing on your own. If the user tells you in the chat to go ahead, call \`${END_PLANNING_TOOL}\` (after submitting the plan, if you have not yet): their message already authorizes implementation; no extra confirmation is needed. Verity starts implementation once your turn ends. End your turn right after it returns. If the user wants to leave planning without a plan, call the same tool with action "discard"; it asks once before restoring file access. Do not create tasks for unaccepted proposal steps. Accepted steps are saved automatically as assigned tasks; update those existing tasks instead of creating duplicates.`;

/** A choice the plan leaves to the user; answered in the chat before implementing. */
export interface PlanDecision {
  question: string;
  /** Empty when the plan asks an open question without listed options. */
  options: string[];
  /** The option the agent recommends, as listed in `options`. */
  recommended?: string;
}

export interface PlanningProposal {
  title: string;
  goal: string;
  steps: string[];
  /** What the plan deliberately leaves out. */
  outOfScope: string;
  /** What the result must satisfy; the implementation is checked against these. */
  criteria: string[];
  /** Open decisions. While any is listed, the plan cannot be implemented. */
  decisions: PlanDecision[];
  /** Screens to mock up and have approved before the rest is implemented. */
  mockups: string[];
}

type Section = 'goal' | 'steps' | 'outOfScope' | 'criteria' | 'decisions' | 'mockups' | 'other';

function sectionOf(heading: string): Section {
  const name = heading.trim().toLowerCase();
  if (/^steps\b/.test(name)) return 'steps';
  if (/^goal\b/.test(name)) return 'goal';
  if (/^(out of scope|not included|non-goals)\b/.test(name)) return 'outOfScope';
  if (/^(acceptance criteria|criteria)\b/.test(name)) return 'criteria';
  // Only the documented heading blocks: "Decisions made" records settled choices.
  if (/^open decisions\b/.test(name)) return 'decisions';
  if (/^mockups?\b/.test(name)) return 'mockups';
  return 'other';
}

/** "None", "N/A" and the like: an empty section written out, not a decision. */
const PLACEHOLDER = /^(?:none|n\/?a|n\.a\.|keine|nothing open|—|-)\.?$/i;

const RECOMMENDED = /\((?:recommended|empfohlen)\)$/i;

/** `**Question?** — Option A (recommended) | Option B`; the bold and the options
 *  are optional, so a plain question still blocks implementation. Parsed with
 *  string operations: the text comes from the agent, and patterns with
 *  adjacent optional whitespace backtrack quadratically on long runs of it. */
function parseDecision(item: string): PlanDecision {
  const line = item.split('\n')[0]!.trim();
  let question = line;
  let rest = '';
  const boldEnd = line.startsWith('**') ? line.indexOf('**', 2) : -1;
  if (boldEnd > 2) {
    question = line.slice(2, boldEnd);
    rest = line.slice(boldEnd + 2);
  } else if (line.includes('?')) {
    question = line.slice(0, line.indexOf('?') + 1);
    rest = line.slice(line.indexOf('?') + 1);
  }
  rest = rest
    .trim()
    .replace(/^[—–:-]/, '')
    .trim();
  const options: string[] = [];
  let recommended: string | undefined;
  for (const raw of rest ? rest.split('|') : []) {
    const trimmed = raw.trim();
    const marked = RECOMMENDED.test(trimmed);
    const option = (marked ? trimmed.replace(RECOMMENDED, '') : trimmed).trim();
    if (!option) continue;
    options.push(option);
    if (marked && recommended === undefined) recommended = option;
  }
  return recommended === undefined
    ? { question: question.trim(), options }
    : { question: question.trim(), options, recommended };
}

/** Shared by the proposal card and task persistence: only numbered steps in the
 * Steps section become accepted tasks, never numbered questions, risks,
 * criteria or decisions. */
export function parsePlanningProposal(markdown: string): PlanningProposal {
  const lines = markdown.trim().split('\n');
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  const title = titleIndex >= 0 ? lines[titleIndex]!.replace(/^#\s+/, '').trim() : '';
  const goal: string[] = [];
  const steps: string[] = [];
  const outOfScope: string[] = [];
  const criteria: string[] = [];
  const decisions: string[] = [];
  const mockups: string[] = [];
  const hasStepsHeading = lines.some((line) => /^#{1,6}\s+steps\b/i.test(line.trim()));
  let section: Section = 'goal';
  for (const [index, line] of lines.entries()) {
    if (index === titleIndex) continue;
    const heading = /^#{1,6}\s+(\S.*)$/.exec(line.trim());
    if (heading) {
      section = sectionOf(heading[1]!);
      continue;
    }
    const step = /^\d{1,3}[.)]\s+(\S.*)$/.exec(line);
    // Only an unindented marker starts an item; nested bullets belong to the one above.
    // `\S` after the spaces keeps these linear: with `.+` the spaces could be split
    // between both groups, and a long run of them backtracks quadratically.
    const item = /^(?:\d{1,3}[.)]|[-*])\s+(\S.*)$/.exec(line);
    if (section === 'criteria' || section === 'decisions' || section === 'mockups') {
      const list =
        section === 'criteria' ? criteria : section === 'decisions' ? decisions : mockups;
      if (item) list.push(item[1]!.trim());
      else if (line.trim() && list.length > 0) list[list.length - 1] += `\n${line.trim()}`;
    } else if (section === 'outOfScope') {
      outOfScope.push(line);
    } else if (step && (section === 'steps' || (!hasStepsHeading && section === 'goal'))) {
      steps.push(step[1]!.trim());
    } else if (section === 'steps' && line.trim() && steps.length > 0) {
      steps[steps.length - 1] += `\n${line.trim()}`;
    } else if (section === 'goal') {
      goal.push(line);
    }
  }
  return {
    title,
    goal: goal.join('\n').trim(),
    steps,
    outOfScope: outOfScope.join('\n').trim(),
    criteria,
    decisions: decisions
      .filter((item) => !PLACEHOLDER.test(item.split('\n')[0]!.trim()))
      .map(parseDecision),
    mockups: mockups.filter((item) => !PLACEHOLDER.test(item.split('\n')[0]!.trim())),
  };
}

export const DISMISSED_PLAN_SYSTEM_PROMPT =
  'The user dismissed the plan. Keep it as context, but do not implement it unless the user asks.';
