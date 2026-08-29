/**
 * Compact, backend-neutral guidance for Verity's durable project memory.
 * It rides the shared fresh-context prompt so every project learns the broker
 * command even when its repository has no AGENTS.md — and steers agents away from
 * saving project knowledge in their own backend's private memory instead.
 */
export const MEMORY_SYSTEM_PROMPT = `# Project memory (Verity)

In a project session, when asked to remember or save durable project information, run \`verity-memory append "<short factual note>"\`. This is the ONLY place for durable project notes—never save them in your backend's own memory (e.g. a Claude \`~/.claude\` memory file, or any per-backend note store), which the operator can't see and no other session or backend inherits. Write the note in English regardless of the conversation language. Store only decisions, conventions, or gotchas—never secrets or transient state. Notes apply to future fresh sessions and are curated in Project Settings. If \`verity-memory\` reports the broker is unconfigured, give the operator the note to add in Project Settings instead of saving it privately.`;
