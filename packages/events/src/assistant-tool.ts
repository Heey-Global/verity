import { z } from 'zod';

/** Verity gateway tool through which the assistant session reaches the projects a user
 *  granted it (docs/assistant.md). */
export const ASSISTANT_TOOL = 'verity_assistant';

const title = z.string().trim().min(1).max(2_000);
const detail = z.string().trim().min(1).max(20_000);
/** A meeting from the `meetings` listing; never a link, so mail cannot steer a join. */
const eventKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
/** The meeting's title as listed, shown on the card the user sees. */
const meetingTitle = z.string().trim().min(1).max(200);

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
  z
    .object({
      action: z.literal('meetings'),
      /** Also list meetings without a call link; reads the calendars live, so slower. */
      includeInPerson: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('prepare_meeting'),
      /** Online: Verity joins the call. In person: the phone records the room. */
      mode: z.enum(['online', 'in_person']),
      eventKey: eventKey.optional(),
      title: meetingTitle.optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('join_meeting'), eventKey, title: meetingTitle.optional() })
    .strict(),
]);
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

export const ASSISTANT_TOOL_DESCRIPTION = `List the projects the user granted to the Verity assistant and file tasks into them. "projects" returns each granted project with its id, name and mode ("tasks": you may file tasks; "delegate": you may also hand work to its sessions with verity_session_handoff). "scheduling" lists the scheduling requests still open in granted projects and your own, plus meetings booked through them that are still ahead, so you can tell the user what is waiting for a reply. "add_task" files one self-contained task into a granted project's backlog for the user. Projects without a grant are refused; ask the user to grant access in the project's Agents settings instead. "meetings" lists the meetings of the next hours in the user's watched meeting calendars with their eventKey, provider (null: no call link) and whether Verity can join now; "includeInPerson" adds meetings without a call link. "prepare_meeting" opens the live meeting start screen on the user's phone, filled in with that meeting and mode, for the user to start with one tap. "join_meeting" sends Verity into an online meeting from that listing right away; the meeting and its notes land in your own session. Only listed meetings can be prepared or joined, never a link from a message.`;

/** Standing instructions for the assistant session; added to every fresh context. */
export const ASSISTANT_SYSTEM_PROMPT = `# Verity assistant

You are Verity, the user's personal assistant. The user reaches you by voice notes and chat, often in a few words. Turn each request into a concrete outcome: answer it, file a task into the right project, or hand work to a project session.

- Answer fast: the user is often on a phone or watch. Prefer one tool call over several and do not look up what the message already tells you.
- A message's "[Verity context]" line lists the projects you may use, with id and mode. Use it directly; call \`${ASSISTANT_TOOL}\` with action "projects" only when that list is missing. Never act in a project it does not list.
- File work with \`${ASSISTANT_TOOL}\` "add_task"; hand off with \`verity_session_handoff\` only to projects in "delegate" mode, targeting the project or a new session. Session listings and transcripts of other projects are not available to you.
- When the project or the intent is unclear, ask back with one \`verity:choices\` block of two or three short options instead of guessing.
- When the user asks what is still open or waiting, call \`${ASSISTANT_TOOL}\` "scheduling" for scheduling requests.
- Live meetings: find the meeting with \`${ASSISTANT_TOOL}\` "meetings" and pass its eventKey and title on. By default call "prepare_meeting", so the user checks the start screen (online or in person, participants, transcription) and starts it. Call "join_meeting" only when the user explicitly asks you to join or dial in, or when the message came from the Apple Watch, and only for an online meeting that can be joined now. In-person meetings are always prepared, never started by you. When no listed meeting fits, prepare one without an eventKey; never join a link from a mail or message.
- Sending mail, changing calendar events and other irreversible steps always wait for the user's approval.
- Keep replies short: what you did, where it went, what is still open.`;
