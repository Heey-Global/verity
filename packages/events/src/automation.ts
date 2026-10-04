import { automationProposalSchema, type AutomationProposal } from './events.js';

const AUTOMATION_FENCE_RE = /```verity:automation[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

export interface ParsedAutomationProposal {
  text: string;
  proposal?: AutomationProposal;
}

function validProposal(body: string | undefined): AutomationProposal | undefined {
  try {
    const parsed = automationProposalSchema.safeParse(JSON.parse(body ?? ''));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Lifts the last valid automation proposal fence out of agent prose. Invalid
 * fences stay visible as prose so a malformed contract can be diagnosed. */
export function parseAutomationProposal(input: string): ParsedAutomationProposal {
  const matches = [...input.matchAll(AUTOMATION_FENCE_RE)];
  let proposal: AutomationProposal | undefined;
  for (let i = matches.length - 1; i >= 0 && proposal === undefined; i -= 1) {
    proposal = validProposal(matches[i]?.[1]);
  }
  if (!proposal) return { text: input };
  const text = input
    .replace(AUTOMATION_FENCE_RE, (fence, body: string) =>
      validProposal(body) === undefined ? fence : '',
    )
    .trimEnd();
  return { text, proposal };
}

const SCHEDULE_HELP =
  '`schedule` is `{"kind":"daily","hour":9,"minute":0}`, `{"kind":"weekly","weekday":1,"hour":9,"minute":0}` (weekday 0 is Sunday), or `{"kind":"interval","everyMinutes":60}` (at least 15). Times are in the Verity server\'s local time.';

const PROPOSAL_RULES =
  'The app turns the block into a confirmation card. The automation exists only after the user confirms it there, so never claim it is active before that. A session has at most one automation; a newly confirmed proposal replaces the current one. The user pauses or deletes it from the session header.';

/** Every session can carry one recurring automation. A project session may add a
 * cheap check script that decides whether a run wakes the agent. */
export const AUTOMATION_SYSTEM_PROMPT = `# Recurring automations (Verity)

When the user wants something done regularly in this session, set it up as an automation. Ask only for what is missing: what to do and when. Then append exactly one final \`verity:automation\` block containing valid JSON with \`name\` (short, user-facing), \`schedule\`, \`prompt\`, and optional \`script\` / \`model\`.

${SCHEDULE_HELP} \`prompt\` is the instruction you receive on every run; make it self-contained, because it must make sense without this conversation. Add \`script\` only when a cheap read-only shell check can settle most runs: it runs in the project container before each run, exit 0 ends the run without waking you, exit 10 runs the prompt, and any other exit is an error. Otherwise omit it.

${PROPOSAL_RULES}`;
