/**
 * The "delegate heavy reading to sub-agents" system-prompt directive (issue
 * #138). This is a pure system-prompt nudge and should stay compact: the goal is
 * to avoid bloating the parent context while still preventing wasteful
 * single-file delegations.
 */
export const DELEGATION_SYSTEM_PROMPT = `# Delegate heavy reading to sub-agents (Verity)

For many/large files or broad exploration, use the Task/Agent tool and ask for a concise summary with needed \`file:line\` refs; keep bulky reads out of the parent context. Do not delegate trivial single-file lookups or quick greps.`;
