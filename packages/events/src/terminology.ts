/**
 * Shared Verity vocabulary for every conversational backend. `operator` remains
 * the precise internal role opposite `agent`/`system`, but should not leak into
 * ordinary replies as a label for the person using the app.
 */
export const TERMINOLOGY_SYSTEM_PROMPT = `# Verity terminology

In Verity internals, "operator" means the person using Verity who directs this session. Treat "operator" as an internal role name. In replies and other user-facing copy, address that person as "you"; do not call them "the operator" unless you are explaining system architecture or quoting an internal identifier.`;
