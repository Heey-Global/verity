import { z } from 'zod';

const safeLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value));

export const sessionProgressRequestSchema = z.object({ sessionId: safeLine(128) }).strict();

export const RECENT_SESSION_MESSAGES_DEFAULT = 20;
export const RECENT_SESSION_MESSAGES_MAX = 50;

export const recentSessionMessagesRequestSchema = z
  .object({
    sessionId: safeLine(128),
    count: z.number().int().min(1).max(RECENT_SESSION_MESSAGES_MAX).optional(),
    sinceMinutes: z.number().int().min(1).max(10_080).optional(),
    beforeSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    purpose: safeLine(240),
  })
  .strict();

export const publishSessionProgressRequestSchema = z
  .object({
    summary: z.string().trim().min(1).max(1_000),
    outcomeDelivered: z.boolean(),
    blocker: z.string().trim().min(1).max(500).optional(),
    requiredDecision: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const SESSION_PROGRESS_TOOL_DESCRIPTION =
  'Read one selected project session’s bounded, structured progress on demand. Returns lifecycle, activity timing, branch and cached PR/Issue association where available, plus a concise published summary/blocker when present. It does not return transcript text and must not be polled. Each call requires user approval.';

export const RECENT_SESSION_MESSAGES_TOOL_DESCRIPTION = `Read a small recent window from one exact project session after user approval. The request must state sessionId, purpose and optional count/time window; count defaults to ${String(RECENT_SESSION_MESSAGES_DEFAULT)} and is capped at ${String(RECENT_SESSION_MESSAGES_MAX)}. Returns only user/assistant/error text with recognized credential patterns redacted, without attachments, tools, hidden prompts or capabilities. Freely written text can contain unrecognizable sensitive material, so the approval must be treated as authorizing the displayed content scope. If hasMore is true, pass nextBeforeSeq as beforeSeq in a fresh approved request for the next older page; never poll it.`;

export const PUBLISH_SESSION_PROGRESS_TOOL_DESCRIPTION =
  'Publish or replace this session’s bounded concise progress summary for later on-demand Control Plane inspection. The server binds the update to the calling session; no sessionId can be supplied. State explicitly whether the requested outcome is delivered, and include a blocker or required decision only when present. The call requires user approval.';
