import { z } from 'zod';

/**
 * The conversation with Verity as every device sees it (docs/assistant.md).
 *
 * The assistant session's own event log stays the record: this contract is a
 * projection of it plus the two ways a device talks back, a message and an answer
 * to the open question. Phone and Watch read the same projection, so a question
 * answered on one device is gone on the other at the next refresh.
 */

/** Client-minted, so a replayed delivery is recognised: Watch queue, app restart. */
const requestId = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

export const assistantDeviceSchema = z.enum(['phone', 'watch']);
export type AssistantDevice = z.infer<typeof assistantDeviceSchema>;

export const assistantMessageRequestSchema = z
  .object({
    requestId,
    text: z.string().trim().min(1).max(8_000),
    /** How the text was entered; voice and typing take the same path. */
    input: z.enum(['voice', 'text']),
    device: assistantDeviceSchema,
    /** The project the user had open, offered to Verity as context, not as a target. */
    projectId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type AssistantMessageRequest = z.infer<typeof assistantMessageRequestSchema>;

export const assistantAnswerRequestSchema = z
  .object({
    requestId,
    /** The {@link AssistantQuestion.id} being answered; a stale id is refused. */
    questionId: z.string().min(1).max(100),
    labels: z.array(z.string().min(1).max(500)).min(1).max(20),
    device: assistantDeviceSchema,
  })
  .strict();
export type AssistantAnswerRequest = z.infer<typeof assistantAnswerRequestSchema>;

export const assistantDeliverySchema = z.object({
  requestId,
  /** False when this request id was delivered before; nothing was sent again. */
  delivered: z.boolean(),
});
export type AssistantDelivery = z.infer<typeof assistantDeliverySchema>;

const at = z.number().int().nonnegative();
const id = z.string().min(1);

export const assistantConversationItemSchema = z.discriminatedUnion('kind', [
  /** What the user said or typed. */
  z.object({
    kind: z.literal('message'),
    id,
    at,
    text: z.string(),
    /** Milliseconds from the message to Verity's first visible reaction and to the
     *  end of her turn; absent while not reached. Optional for older servers. */
    timing: z.object({ firstMs: at.optional(), doneMs: at.optional() }).optional(),
  }),
  /** Verity's answer in prose. */
  z.object({ kind: z.literal('reply'), id, at, text: z.string() }),
  /** A task Verity filed; filing starts no work. */
  z.object({
    kind: z.literal('task'),
    id,
    at,
    title: z.string(),
    projectId: z.string(),
    state: z.enum(['pending', 'saved', 'failed']),
  }),
  /** Work Verity handed to a project session. */
  z.object({
    kind: z.literal('assignment'),
    id,
    at,
    title: z.string(),
    project: z.string().nullable(),
    state: z.enum(['pending', 'sent', 'failed']),
  }),
  /** A live meeting Verity prepared on the start screen or joined. Both belong to the
   *  conversation's own session, where the meeting screen opens. */
  z.object({
    kind: z.literal('meeting'),
    id,
    at,
    /** `prepare`: the start screen waits for the user. `join`: Verity dials in herself. */
    action: z.enum(['prepare', 'join']),
    mode: z.enum(['online', 'in_person']),
    /** The calendar event the start screen selects; absent for a meeting to fill in. */
    eventKey: z.string().nullable(),
    title: z.string().nullable(),
    state: z.enum(['pending', 'ready', 'failed']),
  }),
  z.object({ kind: z.literal('error'), id, at, text: z.string() }),
]);
export type AssistantConversationItem = z.infer<typeof assistantConversationItemSchema>;

/** Items a device understands. A newer server may add kinds; dropping them keeps the
 *  rest of the conversation readable instead of failing the whole read. */
const assistantConversationItemsSchema = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = assistantConversationItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }),
);

export const assistantQuestionSchema = z.object({
  id,
  question: z.string().optional(),
  options: z.array(z.object({ label: z.string(), recommended: z.boolean().optional() })).min(1),
  multiSelect: z.boolean(),
});
export type AssistantQuestion = z.infer<typeof assistantQuestionSchema>;

/** An approval Verity waits for; decided in the session, never by a Watch tap. */
export const assistantApprovalSchema = z.object({ id, tool: z.string() });
export type AssistantApproval = z.infer<typeof assistantApprovalSchema>;

export const assistantConversationSchema = z.object({
  /** `disabled`: switched off in system settings. `unavailable`: on, but its session is gone. */
  availability: z.enum(['ready', 'disabled', 'unavailable']),
  sessionId: z.string().nullable(),
  /** Rises with every change; a device skips rendering an unchanged revision. */
  revision: z.number().int().nonnegative(),
  state: z.enum(['idle', 'working', 'needs_you', 'failed']),
  items: assistantConversationItemsSchema,
  question: assistantQuestionSchema.nullable(),
  approvals: z.array(assistantApprovalSchema),
});
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;

/**
 * Opens the line that tells Verity where the user was. The projection strips it
 * from the user's message, so the transcript shows what they actually said.
 */
export const ASSISTANT_CONTEXT_TAG = '[Verity context]';

/** Introduces the granted projects on the context line. */
export const ASSISTANT_PROJECTS_LABEL = 'Projects you may use:';

/** A project the assistant may use, as listed in a message's context. */
export interface AssistantContextProject {
  projectId: string;
  name: string;
  /** `tasks` or `delegate`, as the assistant tool reports it. */
  mode: string;
}

/** Keeps free text on the one context line. */
const contextText = (value: string) => value.replace(/["\r\n]/g, ' ');

/**
 * The prompt for one message: the user's words, then where they were and which
 * projects Verity may use. Listing the projects here spares every turn the model
 * round that would otherwise ask for them first.
 */
export function assistantMessagePrompt(
  text: string,
  context: {
    device: AssistantDevice;
    input: 'voice' | 'text';
    project?: string;
    projects?: readonly AssistantContextProject[];
  },
): string {
  const parts = [
    `sent from the ${context.device === 'watch' ? 'Apple Watch' : 'phone'}`,
    context.input === 'voice' ? 'dictated' : 'typed',
    // A project name is free text; keep it on the one context line.
    ...(context.project !== undefined
      ? [`while project "${contextText(context.project)}" was open`]
      : []),
  ];
  const line = `${ASSISTANT_CONTEXT_TAG} ${parts.join(', ')}.`;
  if (context.projects === undefined) return `${text.trim()}\n\n${line}`;
  const projects =
    context.projects.length === 0
      ? 'none'
      : context.projects
          .map((p) => `"${contextText(p.name)}" (id ${contextText(p.projectId)}, ${p.mode})`)
          .join('; ');
  return `${text.trim()}\n\n${line} ${ASSISTANT_PROJECTS_LABEL} ${projects}.`;
}

/** The user's own words of a prompt built by {@link assistantMessagePrompt}. */
export function assistantMessageText(prompt: string): string {
  const index = prompt.lastIndexOf(`\n\n${ASSISTANT_CONTEXT_TAG} `);
  return index === -1 ? prompt : prompt.slice(0, index);
}
