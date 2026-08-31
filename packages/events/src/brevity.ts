/**
 * The "keep the operator-facing answer concise" system-prompt directive. Pairs
 * with {@link DELEGATION_SYSTEM_PROMPT}: sub-agents are told to summarize, but
 * nothing stopped the parent from pasting that summary back verbatim as a wall
 * of prose. This nudges the final chat reply to lead with the outcome and link
 * by `file:line` instead of reproducing full reports/listings. Like the other
 * runtime nudges it stays compact so it doesn't bloat the re-sent context.
 */
export const BREVITY_SYSTEM_PROMPT = `# Keep the operator reply concise (Verity)

The chat bubble is for the operator, not a scratchpad. Lead with the outcome; skip preambles like "Great, now I have everything I need". When a sub-agent returns a long report, summarize the takeaways and point to \`file:line\` rather than pasting the full listing. Reproduce large blocks verbatim only when the operator explicitly asks for them.`;
