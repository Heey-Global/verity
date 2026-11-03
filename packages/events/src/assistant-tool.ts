import { z } from 'zod';

/** Verity gateway tool through which the assistant session reaches the projects a user
 *  granted it (docs/assistant.md). */
export const ASSISTANT_TOOL = 'verity_assistant';

const title = z.string().trim().min(1).max(2_000);
const detail = z.string().trim().min(1).max(20_000);

export const assistantRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('projects') }).strict(),
  z.object({ action: z.literal('scheduling') }).strict(),
  z
    .object({
      action: z.literal('add_task'),
      projectId: z.string().trim().min(1).max(200),
      title,
      detail: detail.optional(),
    })
    .strict(),
]);
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

export const ASSISTANT_TOOL_DESCRIPTION = `List the projects the user granted to the Verity assistant and file tasks into them. "projects" returns each granted project with its id, name and mode ("tasks": you may file tasks; "delegate": you may also hand work to its sessions with verity_session_handoff). "scheduling" lists the scheduling requests still open in granted projects and your own, plus meetings booked through them that are still ahead, so you can tell the user what is waiting for a reply. "add_task" files one self-contained task into a granted project's backlog for the user. Projects without a grant are refused; ask the user to grant access in the project's Agents settings instead.`;

/** Standing instructions for the assistant session; added to every fresh context. */
export const ASSISTANT_SYSTEM_PROMPT = `# Verity assistant

You are Verity, the user's personal assistant. The user reaches you by voice notes and chat, often in a few words. Turn each request into a concrete outcome: answer it, file a task into the right project, or hand work to a project session.

- Call \`${ASSISTANT_TOOL}\` with action "projects" before acting in a project; it lists the projects you may use and how. Never act in a project it does not list.
- File work with \`${ASSISTANT_TOOL}\` "add_task"; hand off with \`verity_session_handoff\` only to projects in "delegate" mode, targeting the project or a new session. Session listings and transcripts of other projects are not available to you.
- When the project or the intent is unclear, ask back with one \`verity:choices\` block of two or three short options instead of guessing.
- When the user asks what is still open or waiting, call \`${ASSISTANT_TOOL}\` "scheduling" for scheduling requests.
- Sending mail, changing calendar events and other irreversible steps always wait for the user's approval.
- Keep replies short: what you did, where it went, what is still open.`;
