import {
  assistantAnswerRequestSchema,
  assistantMessagePrompt,
  assistantMessageRequestSchema,
  formatChoiceAnswer,
  type AssistantContextProject,
  type AssistantConversation,
} from '@verity/events';
import type { EventStore, SequencedEvent } from '@verity/store';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  projectAssistantConversation,
  type AssistantSessionFacts,
} from './assistant-conversation.js';

/** How a turn dispatch ended; a refusal carries the HTTP status the turn route would use. */
export type AssistantDispatchResult = { ok: true } | { ok: false; status: number; error: string };

export interface AssistantConversationRouteDeps {
  /** Whether the stored session still exists; reads never create it. */
  sessionExists(sessionId: string): Promise<boolean>;
  /** The newest events of the session, ascending. */
  recentEvents(sessionId: string): Promise<SequencedEvent[]>;
  facts(sessionId: string): Promise<AssistantSessionFacts>;
  /** Calls `listener` for each event the session persists from now on. */
  subscribe(sessionId: string, listener: () => void): () => void;
  /** The projects Verity may use for `userId`, listed in each message's context. */
  projects(userId: string): Promise<AssistantContextProject[]>;
  /** Sends one turn as `userId`; `requestId` doubles as the conductor's replay key. */
  dispatch(
    sessionId: string,
    prompt: string,
    turn: { userId: string; requestId: string },
  ): Promise<AssistantDispatchResult>;
}

/** The longest a read waits for a change; well inside common proxy and client timeouts. */
export const ASSISTANT_WAIT_MAX_MS = 25_000;
/** After the first change, how long a waiting read collects more before answering,
 *  so a reply streamed in many small deltas costs a few reads, not one per word. */
export const ASSISTANT_WAIT_SETTLE_MS = 120;

const readQuerySchema = z.object({
  /** The revision the device already shows; the read waits while it is current. */
  after: z.coerce.number().int().nonnegative().optional(),
  waitMs: z.coerce.number().int().nonnegative().optional(),
});

const EMPTY = { revision: 0, state: 'idle', items: [], question: null, approvals: [] } as const;

/**
 * The conversation with Verity for phone and Watch (docs/assistant.md).
 *
 * The assistant is one Verity Control session, so these routes stay with the
 * administrators who can read it, like its settings. A member is refused rather
 * than given a view into someone else's assistant.
 */
export function registerAssistantConversationRoutes(
  app: FastifyInstance,
  store: EventStore,
  deps: AssistantConversationRouteDeps,
): void {
  const administrator = async (request: FastifyRequest) =>
    request.localUserId != null && (await store.isActiveAdministrator(request.localUserId));

  /** The assistant session when it is on and exists, else the reason it is not. */
  const session = async (): Promise<
    { sessionId: string } | { availability: 'disabled' | 'unavailable' }
  > => {
    const settings = await store.assistant.settings();
    if (!settings.enabled) return { availability: 'disabled' };
    if (settings.session_id === null || !(await deps.sessionExists(settings.session_id)))
      return { availability: 'unavailable' };
    return { sessionId: settings.session_id };
  };

  const conversation = async (sessionId: string) =>
    projectAssistantConversation(await deps.recentEvents(sessionId), await deps.facts(sessionId));

  /** Refuses non-administrators and an assistant that cannot take a turn. */
  const gate = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await administrator(request))) {
      await reply.code(403).send({ error: 'Administrator access required' });
      return undefined;
    }
    const found = await session();
    if ('availability' in found) {
      await reply.code(409).send({
        error:
          found.availability === 'disabled'
            ? 'The Verity assistant is switched off in system settings.'
            : 'The Verity assistant session is not available. Switch it on again in settings.',
        code: found.availability,
      });
      return undefined;
    }
    return { sessionId: found.sessionId, userId: request.localUserId! };
  };

  const send = async (
    reply: FastifyReply,
    target: { sessionId: string; userId: string },
    requestId: string,
    prompt: string,
  ) => {
    const result = await deps
      .dispatch(target.sessionId, prompt, { userId: target.userId, requestId })
      .catch(async (error: unknown) => {
        await store.assistant.releaseRequest(requestId);
        throw error;
      });
    if (!result.ok) {
      await store.assistant.releaseRequest(requestId);
      return reply.code(result.status).send({ error: result.error });
    }
    await store.assistant.acceptRequest(requestId);
    return reply.code(202).send({ requestId, delivered: true });
  };

  /**
   * The conversation now, or, given `after` and `waitMs`, as soon as it moves past
   * the revision the device shows. Devices hold one such read open instead of
   * polling on a timer, so Verity's reply reaches them as she writes it.
   */
  app.get('/assistant/conversation', async (request, reply): Promise<unknown> => {
    const query = readQuerySchema.parse(request.query);
    if (!(await administrator(request)))
      return reply.code(403).send({ error: 'Administrator access required' });
    const found = await session();
    if ('availability' in found)
      return { availability: found.availability, sessionId: null, ...EMPTY };
    const wait = Math.min(query.waitMs ?? 0, ASSISTANT_WAIT_MAX_MS);
    // Subscribed before the read, so a change between reading and waiting still wakes it.
    const changed = wait > 0 && query.after !== undefined ? watch(request, found.sessionId) : null;
    try {
      let current = await conversation(found.sessionId);
      if (changed !== null && current.revision === query.after && (await changed.next(wait)))
        current = await conversation(found.sessionId);
      return {
        availability: 'ready',
        sessionId: found.sessionId,
        ...current,
      } satisfies AssistantConversation;
    } finally {
      changed?.close();
    }
  });

  /** Resolves `next` with true once an event arrived and settled, false on timeout or disconnect. */
  const watch = (request: FastifyRequest, sessionId: string) => {
    let seen = false;
    let wake: (() => void) | undefined;
    const unsubscribe = deps.subscribe(sessionId, () => {
      seen = true;
      wake?.();
    });
    const timers: NodeJS.Timeout[] = [];
    const onClose = () => wake?.();
    request.raw.once('close', onClose);
    return {
      next: (timeoutMs: number) =>
        new Promise<boolean>((resolve) => {
          const settle = () => {
            wake = undefined;
            timers.push(setTimeout(() => resolve(seen), ASSISTANT_WAIT_SETTLE_MS));
          };
          if (seen) return settle();
          wake = () => (seen ? settle() : resolve(false));
          timers.push(setTimeout(() => resolve(false), timeoutMs));
        }),
      close: () => {
        unsubscribe();
        request.raw.off('close', onClose);
        for (const timer of timers) clearTimeout(timer);
      },
    };
  };

  app.post('/assistant/conversation/messages', async (request, reply): Promise<unknown> => {
    const body = assistantMessageRequestSchema.parse(request.body);
    const target = await gate(request, reply);
    if (target === undefined) return reply;
    // Context only: a project deleted meanwhile is left out rather than refused.
    const project =
      body.projectId === undefined ? undefined : await store.getProject(body.projectId);
    // Before the claim: a failure here must not leave the request id pending.
    const projects = await deps.projects(target.userId);
    const claim = await store.assistant.claimRequest({
      requestId: body.requestId,
      sessionId: target.sessionId,
      userId: target.userId,
      kind: 'message',
    });
    if (!claim.claimed) return replay(reply, claim, target, body.requestId, 'message');
    const prompt = assistantMessagePrompt(body.text, {
      device: body.device,
      input: body.input,
      projects,
      ...(project !== undefined ? { project: `${project.owner}/${project.repo}` } : {}),
    });
    return send(reply, target, body.requestId, prompt);
  });

  app.post('/assistant/conversation/answers', async (request, reply): Promise<unknown> => {
    const body = assistantAnswerRequestSchema.parse(request.body);
    const target = await gate(request, reply);
    if (target === undefined) return reply;
    // A replay is recognised before the question is checked: once answered, it is
    // closed, and the device that answered must still see its own success.
    const previous = await store.assistant.request(body.requestId);
    if (previous !== undefined)
      return replay(
        reply,
        { claimed: false, request: previous },
        target,
        body.requestId,
        'answer',
        body.questionId,
      );
    const { question } = await conversation(target.sessionId);
    if (question === null || question.id !== body.questionId)
      return reply.code(409).send({
        error: 'This question was already answered or replaced.',
        code: 'stale_question',
      });
    const offered = new Set(question.options.map((option) => option.label));
    if (
      body.labels.some((label) => !offered.has(label)) ||
      new Set(body.labels).size !== body.labels.length ||
      (!question.multiSelect && body.labels.length !== 1)
    )
      return reply.code(400).send({ error: 'The answer must be one of the offered options.' });
    const claim = await store.assistant.claimRequest({
      requestId: body.requestId,
      sessionId: target.sessionId,
      userId: target.userId,
      kind: 'answer',
      questionId: body.questionId,
    });
    if (!claim.claimed)
      return replay(reply, claim, target, body.requestId, 'answer', body.questionId);
    return send(reply, target, body.requestId, formatChoiceAnswer(body.labels));
  });
}

function replay(
  reply: FastifyReply,
  claim: Exclude<Awaited<ReturnType<EventStore['assistant']['claimRequest']>>, { claimed: true }>,
  target: { sessionId: string; userId: string },
  requestId: string,
  kind: 'message' | 'answer',
  questionId?: string,
) {
  if ('answeredBy' in claim)
    return reply.code(409).send({ error: 'This question was already answered.', code: 'answered' });
  // A request id belongs to the user and session that minted it.
  // ...and to the one message or answer it was minted for.
  if (
    claim.request.user_id !== target.userId ||
    claim.request.session_id !== target.sessionId ||
    claim.request.kind !== kind ||
    (questionId !== undefined && claim.request.question_id !== questionId)
  )
    return reply.code(409).send({ error: 'This request id is already in use.', code: 'conflict' });
  if (claim.request.state === 'pending')
    return reply
      .code(409)
      .send({ error: 'This request is still being delivered. Retry shortly.', code: 'pending' });
  return reply.code(200).send({ requestId, delivered: false });
}
