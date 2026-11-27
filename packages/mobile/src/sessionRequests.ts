import { z } from 'zod';

/**
 * The current turn's unanswered `verity:choices` block, as the session list
 * carries it. Options keep the agent's labels verbatim: a label is what is sent
 * as the answer. A block that no longer parses (a newer server, a malformed
 * option) reads as "no open question" rather than failing the whole list.
 */
export const openChoicesSchema = z.object({
  question: z.string().optional(),
  options: z
    .array(z.object({ label: z.string().min(1), recommended: z.boolean().optional() }))
    .min(1),
  multiSelect: z.boolean().optional(),
});

/** Whether a session's requests are for the requester (ADR 0023): its questions,
 * plans and mockups on the session, a prompt's own on each permission request.
 * ABSENT = older server or no accounts, so everything is for whoever sees it. */
export const addressedToViewerSchema = z.boolean().optional().catch(undefined);
