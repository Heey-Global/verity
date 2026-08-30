import { agentLoopProposalSchema, type AgentLoopProposal } from './events.js';

const AGENT_LOOP_FENCE_RE = /```verity:agent-loop[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

export interface ParsedAgentLoopProposal {
  text: string;
  proposal?: AgentLoopProposal;
}

/** Lifts the last valid Agent Loop proposal fence out of agent prose. */
export function parseAgentLoopProposal(input: string): ParsedAgentLoopProposal {
  const matches = [...input.matchAll(AGENT_LOOP_FENCE_RE)];
  let proposal: AgentLoopProposal | undefined;
  for (let i = matches.length - 1; i >= 0 && proposal === undefined; i -= 1) {
    try {
      const parsed = agentLoopProposalSchema.safeParse(JSON.parse(matches[i]?.[1] ?? ''));
      if (parsed.success) proposal = parsed.data;
    } catch {
      // Invalid contract blocks remain visible as prose so they can be diagnosed.
    }
  }
  if (!proposal) return { text: input };
  const text = input
    .replace(AGENT_LOOP_FENCE_RE, (fence, body: string) => {
      try {
        return agentLoopProposalSchema.safeParse(JSON.parse(body)).success ? '' : fence;
      } catch {
        return fence;
      }
    })
    .trimEnd();
  return { text, proposal };
}

export const AGENT_LOOP_PROPOSAL_SYSTEM_PROMPT = `# Agent Loop proposals (Verity)

When configuring an Agent Loop, ask focused questions until the script and schedule are complete. Then append exactly one final \`verity:agent-loop\` block containing valid JSON with \`loopId\`, \`name\`, \`script\`, \`schedule\`, and optional \`reactionPrompt\` / \`reactionModel\`. The app shows a confirmation widget; never claim the loop is saved, tested, or enabled before the user confirms it.`;
