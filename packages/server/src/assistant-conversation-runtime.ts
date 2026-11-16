import type { AssistantContextProject } from '@verity/events';
import { QueueFullError, SessionBusyError, UnknownSessionError } from '@verity/session';
import type { EventStore, SequencedEvent } from '@verity/store';

import type { AssistantConversationRouteDeps } from './assistant-conversation-routes.js';
import type { SessionStatus } from './status.js';

/** Verity answers on phone and Watch, so she runs on the faster Sonnet. */
export const ASSISTANT_MODEL = 'claude-sonnet-5-5';
/** The model assistant sessions were created with before; moved to {@link ASSISTANT_MODEL}. */
export const PREVIOUS_ASSISTANT_MODEL = 'claude-opus-5-5';

interface Log {
  info: (details: object, message: string) => void;
  warn: (details: object, message: string) => void;
}

export interface AssistantModelMoveDeps {
  store: Pick<
    EventStore,
    'getSession' | 'getSessionBackendStates' | 'setSessionModel' | 'deleteSessionBackendStates'
  >;
  isBusy: (sessionId: string) => boolean;
  /** Whether {@link ASSISTANT_MODEL} is offered by this installation. */
  available: () => Promise<boolean>;
  /** Runs `handoff` under the session's backend fence, as an operator's model switch does. */
  runBackendHandoff: (sessionId: string, handoff: () => Promise<boolean>) => Promise<unknown>;
  closeSession: (sessionId: string) => void;
  log: Log;
}

/**
 * Moves an assistant session created on the former default model to
 * {@link ASSISTANT_MODEL}, like an operator's model switch: under the backend
 * fence, with the old resume handles dropped so the next turn resumes from the
 * transcript. Only between turns, and only when Sonnet is available; otherwise
 * the session keeps its model and is tried again with the next message.
 */
export async function moveAssistantToFastModel(
  deps: AssistantModelMoveDeps,
  sessionId: string,
): Promise<void> {
  try {
    const session = await deps.store.getSession(sessionId);
    if (session?.model !== PREVIOUS_ASSISTANT_MODEL || deps.isBusy(sessionId)) return;
    if (!(await deps.available())) return;
    await deps.runBackendHandoff(sessionId, async () => {
      const live = await deps.store.getSession(sessionId);
      if (live?.model !== PREVIOUS_ASSISTANT_MODEL) return false;
      const previous = await deps.store.getSessionBackendStates(sessionId);
      if (!(await deps.store.setSessionModel(sessionId, ASSISTANT_MODEL))) return false;
      try {
        await deps.store.deleteSessionBackendStates(sessionId);
      } catch (error) {
        await deps.store.setSessionModel(sessionId, live.model);
        throw error;
      }
      deps.closeSession(sessionId);
      for (const state of previous) deps.closeSession(state.backendSessionId);
      return true;
    });
  } catch (error) {
    deps.log.warn({ err: error, sessionId }, 'verity: assistant model switch deferred');
  }
}

/**
 * Logs how long one message took: to Verity's first visible reaction and to the
 * end of the turn, from when the server accepted it. Call it before dispatching:
 * an idle session persists the prompt inside the dispatch. The prompt is
 * recognised by its text; a message queued behind another turn also counts the wait.
 */
export function watchAssistantTiming(
  subscribe: (sessionId: string, listener: (event: SequencedEvent) => void) => () => void,
  log: Log,
  turn: { sessionId: string; requestId: string; prompt: string },
): { cancel(): void } {
  const accepted = Date.now();
  let started = false;
  let firstMs: number | undefined;
  let firstAnswerMs: number | undefined;
  let queueMs: number | undefined;
  let promptSeq: number | undefined;
  const stop = subscribe(turn.sessionId, ({ event, seq }) => {
    if (!started) {
      started = event.t === 'prompt' && event.peer === undefined && event.text === turn.prompt;
      if (started) {
        promptSeq = seq;
        queueMs = Date.now() - accepted;
      }
      return;
    }
    const topLevel = !('parentToolId' in event) || event.parentToolId === undefined;
    if (
      firstMs === undefined &&
      topLevel &&
      (event.t === 'text' || event.t === 'tool_call' || event.t === 'error')
    )
      firstMs = Date.now() - accepted;
    if (firstAnswerMs === undefined && topLevel && event.t === 'text' && event.delta.trim()) {
      firstAnswerMs = Date.now() - accepted;
      log.info(
        { sessionId: turn.sessionId, requestId: turn.requestId, promptSeq, firstAnswerMs, queueMs },
        'verity: assistant first answer',
      );
    }
    if (event.t === 'result' || event.t === 'interrupted') finish(event.t);
  });
  const timer = setTimeout(() => finish('unfinished'), 15 * 60_000);
  timer.unref();
  function finish(outcome: string) {
    stop();
    clearTimeout(timer);
    log.info(
      {
        sessionId: turn.sessionId,
        requestId: turn.requestId,
        outcome,
        firstMs,
        firstAnswerMs,
        queueMs,
        promptSeq,
        doneMs: Date.now() - accepted,
      },
      'verity: assistant message timing',
    );
  }
  return {
    cancel: () => {
      stop();
      clearTimeout(timer);
    },
  };
}

export interface AssistantConversationWiring {
  store: Pick<EventStore, 'getSession' | 'getEventsBeforeSeq'> & AssistantModelMoveDeps['store'];
  subscribe: (sessionId: string, listener: (event: SequencedEvent) => void) => () => void;
  isBusy: (sessionId: string) => boolean;
  /** The session summary the app shows, for status, open choices and approvals. */
  summarize: (session: NonNullable<Awaited<ReturnType<EventStore['getSession']>>>) => Promise<{
    status: SessionStatus;
    openChoices?: unknown;
    pendingPermissionRequests?: readonly { toolUseId: string; tool: string }[] | undefined;
  }>;
  projects: (userId: string) => Promise<AssistantContextProject[]>;
  dispatchTurn: (
    sessionId: string,
    prompt: string,
    turn: { clientReplyId: string; initiatedBy: { userId: string } },
  ) => Promise<unknown>;
  /** Newest events read per projection; text arrives as many small deltas. */
  recentEvents: number;
  modelMove: Omit<AssistantModelMoveDeps, 'store' | 'isBusy' | 'log'>;
  log: Log;
}

/** What the conversation routes need, built from the server's session machinery. */
export function assistantConversationDeps(
  wiring: AssistantConversationWiring,
): AssistantConversationRouteDeps {
  const modelMove: AssistantModelMoveDeps = {
    ...wiring.modelMove,
    store: wiring.store,
    isBusy: wiring.isBusy,
    log: wiring.log,
  };
  return {
    sessionExists: async (id) => (await wiring.store.getSession(id)) !== undefined,
    recentEvents: async (id) =>
      (await wiring.store.getEventsBeforeSeq(id, wiring.recentEvents)).events,
    facts: async (id) => {
      const session = await wiring.store.getSession(id);
      if (session === undefined) throw new UnknownSessionError(id);
      const summary = await wiring.summarize(session);
      return {
        status: summary.status,
        busy: wiring.isBusy(id),
        choicesOpen: summary.openChoices !== undefined,
        approvals: (summary.pendingPermissionRequests ?? []).map((approval) => ({
          toolUseId: approval.toolUseId,
          tool: approval.tool,
        })),
      };
    },
    subscribe: (id, listener) => wiring.subscribe(id, () => listener()),
    projects: (userId) => wiring.projects(userId),
    dispatch: async (id, prompt, turn) => {
      await moveAssistantToFastModel(modelMove, id);
      // Watching before the dispatch: an idle session persists the prompt inside it.
      const timing = watchAssistantTiming(wiring.subscribe, wiring.log, {
        sessionId: id,
        requestId: turn.requestId,
        prompt,
      });
      try {
        await wiring.dispatchTurn(id, prompt, {
          clientReplyId: turn.requestId,
          initiatedBy: { userId: turn.userId },
        });
        return { ok: true };
      } catch (error) {
        timing.cancel();
        if (error instanceof UnknownSessionError)
          return { ok: false, status: 409, error: 'The Verity assistant session is gone.' };
        if (error instanceof QueueFullError)
          return { ok: false, status: 429, error: 'Verity has too many messages waiting.' };
        // Transient: devices retry a 503 under the same request id.
        if (error instanceof SessionBusyError)
          return { ok: false, status: 503, error: 'Verity is restarting. Try again shortly.' };
        throw error;
      }
    },
  };
}
