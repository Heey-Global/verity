import type { SequencedEvent } from '@verity/store';
import type { PushSessionContext } from './pr-ready-push.js';
import type { PushLogger, PushSender } from './push-sender.js';

const DEFAULT_PRESENCE_DEBOUNCE_MS = 750;
const TERMINAL_STATE_RETENTION_MS = 5 * 60 * 1_000;
const TERMINAL_ERROR_KINDS = new Set(['spawn_failed', 'run_failed', 'crashed']);
// Only the very end of the turn's prose decides "did it end on a question"; a
// short rolling tail is enough and bounds memory on a long, chatty turn.
const QUESTION_TAIL_MAX_CHARS = 512;

interface SessionFireState {
  readonly openTasks: Set<string>;
  terminalHandled: boolean;
  readonly handledPermissions: Set<string>;
  /** Rolling tail of the current turn's top-level agent prose (Block 0). At turn
   * end it decides whether a completion fires the ordinary SESSION_STATUS or the
   * actionable AGENT_QUESTION. Bounded, and reset at every turn boundary. */
  questionTail: string;
}

/** Append a text delta to the rolling question tail, keeping only the last
 * {@link QUESTION_TAIL_MAX_CHARS} characters. */
function appendQuestionTail(tail: string, delta: string): string {
  const combined = tail + delta;
  return combined.length > QUESTION_TAIL_MAX_CHARS
    ? combined.slice(-QUESTION_TAIL_MAX_CHARS)
    : combined;
}

/** A turn "ends with a question" when its final top-level prose — ignoring
 * trailing whitespace and common closing wrappers (quotes, brackets, emphasis
 * marks) — ends in a question mark. Deliberately fail-safe, not fail-loud: a
 * miss degrades to the ordinary completion notification, a false positive only
 * sends a low-cost reply prompt (ADR 0008 §Fire points). */
function endsWithQuestion(tail: string): boolean {
  return tail.replace(/[\s"'`)*_\]]+$/u, '').endsWith('?');
}

/** A live session WebSocket means that session is visible on at least one
 * device. Presence is deliberately session-wide: one foreground viewer
 * suppresses the notification fan-out to every paired device. */
export interface PushForegroundPresence {
  attach(sessionId: string): () => void;
  hasViewer(sessionId: string): boolean;
}

export function createPushForegroundPresence(): PushForegroundPresence {
  const viewers = new Map<string, number>();
  return {
    attach(sessionId): () => void {
      viewers.set(sessionId, (viewers.get(sessionId) ?? 0) + 1);
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        const remaining = (viewers.get(sessionId) ?? 1) - 1;
        if (remaining <= 0) viewers.delete(sessionId);
        else viewers.set(sessionId, remaining);
      };
    },
    hasViewer(sessionId): boolean {
      return (viewers.get(sessionId) ?? 0) > 0;
    },
  };
}

export interface PushFirePoints {
  observe(sessionId: string, event: SequencedEvent): void;
  permissionResolved(sessionId: string, toolUseId: string): void;
  close(): Promise<void>;
}

export interface PushFirePointOptions {
  sender: PushSender;
  presence: PushForegroundPresence;
  logger?: PushLogger | undefined;
  debounceMs?: number | undefined;
  describeSession?: ((sessionId: string) => Promise<PushSessionContext>) | undefined;
}

function pushHeading(context: PushSessionContext, purpose: string): string {
  return `${context.project?.trim() || 'Verity'} · ${purpose}`;
}

function pushSessionName(context: PushSessionContext): string {
  return context.session?.trim() || 'A session';
}

class DefaultPushFirePoints implements PushFirePoints {
  private readonly debounceMs: number;
  private readonly sessions = new Map<string, SessionFireState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly active = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: PushFirePointOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_PRESENCE_DEBOUNCE_MS;
  }

  observe(sessionId: string, sequenced: SequencedEvent): void {
    if (this.closed) return;
    const { event } = sequenced;
    const state = this.state(sessionId);

    if (event.t === 'session' || event.t === 'prompt') {
      state.terminalHandled = false;
      state.questionTail = '';
      this.cancel(`terminal:${sessionId}`);
      this.cancel(`cleanup:${sessionId}`);
      this.cancelPermissions(sessionId, state);
      state.handledPermissions.clear();
      return;
    }
    if (event.t === 'task') {
      if (event.phase === 'started') {
        state.openTasks.add(event.id);
        state.terminalHandled = false;
      } else if (event.phase === 'ended') {
        state.openTasks.delete(event.id);
      }
      return;
    }
    if (event.t === 'text') {
      // Only top-level agent prose counts toward "the agent asked the operator a
      // question"; text nested under a tool (`parentToolId`) is a subagent's own
      // output, not a question directed at the operator.
      if (event.parentToolId === undefined) {
        state.questionTail = appendQuestionTail(state.questionTail, event.delta);
      }
      return;
    }
    if (event.t === 'permission') {
      if (state.handledPermissions.has(event.id)) return;
      state.handledPermissions.add(event.id);
      this.schedule(`permission:${sessionId}:${event.id}`, sessionId, 'permission', async () => {
        const context = await this.describeSession(sessionId);
        return this.options.sender.send({
          title: pushHeading(context, 'Permission needed'),
          body: `${pushSessionName(context)} wants to run ${event.tool}.`,
          categoryId: 'PERMISSION_PROMPT',
          data: { sessionId, kind: 'permission', toolUseId: event.id },
          priority: 'high',
        });
      });
      return;
    }
    if (event.t === 'status') {
      if (event.state === 'running') {
        state.terminalHandled = false;
        state.questionTail = '';
        this.cancel(`terminal:${sessionId}`);
      } else if (event.state === 'completed') {
        this.scheduleCompletion(sessionId, state);
      } else if (event.state === 'crashed') {
        this.scheduleTerminal(sessionId, 'crashed', state);
      }
      return;
    }
    if (event.t === 'result' && state.openTasks.size === 0) {
      this.scheduleCompletion(sessionId, state);
      return;
    }
    if (event.t === 'error' && TERMINAL_ERROR_KINDS.has(event.kind)) {
      this.scheduleTerminal(sessionId, 'crashed', state);
    }
  }

  permissionResolved(sessionId: string, toolUseId: string): void {
    const key = `permission:${sessionId}:${toolUseId}`;
    this.cancel(key);
    this.state(sessionId).handledPermissions.add(toolUseId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.active]);
  }

  private state(sessionId: string): SessionFireState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        openTasks: new Set(),
        terminalHandled: false,
        handledPermissions: new Set(),
        questionTail: '',
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** A turn that finished normally is either an actionable question (fire the
   * AGENT_QUESTION reply category) or an ordinary completion. Both are a single
   * per-turn terminal notification, so they share the `terminal:` timer key and
   * the `terminalHandled` guard — only one ever fires. */
  private scheduleCompletion(sessionId: string, state: SessionFireState): void {
    this.scheduleTerminal(
      sessionId,
      endsWithQuestion(state.questionTail) ? 'question' : 'completed',
      state,
    );
  }

  private scheduleTerminal(
    sessionId: string,
    outcome: 'completed' | 'crashed' | 'question',
    state: SessionFireState,
  ): void {
    if (state.terminalHandled) return;
    state.terminalHandled = true;
    this.cancelPermissions(sessionId, state);
    this.scheduleStateCleanup(sessionId, state);
    this.schedule(`terminal:${sessionId}`, sessionId, outcome, async () => {
      const context = await this.describeSession(sessionId);
      return this.options.sender.send(
        outcome === 'question'
          ? {
              title: pushHeading(context, 'Reply needed'),
              body: `${pushSessionName(context)} is waiting for your answer.`,
              categoryId: 'AGENT_QUESTION',
              data: { sessionId, kind: 'question' },
              priority: 'high',
            }
          : {
              title: pushHeading(
                context,
                outcome === 'completed' ? 'Turn complete' : 'Session stopped',
              ),
              body:
                outcome === 'completed'
                  ? `${pushSessionName(context)} finished its turn.`
                  : `${pushSessionName(context)} stopped unexpectedly.`,
              categoryId: 'SESSION_STATUS',
              data: { sessionId, kind: outcome },
              priority: outcome === 'completed' ? 'normal' : 'high',
            },
      );
    });
  }

  private async describeSession(sessionId: string): Promise<PushSessionContext> {
    return (await this.options.describeSession?.(sessionId).catch(() => ({}))) ?? {};
  }

  private schedule(
    key: string,
    sessionId: string,
    kind: 'permission' | 'completed' | 'crashed' | 'question',
    send: () => Promise<unknown>,
  ): void {
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (this.closed || this.options.presence.hasViewer(sessionId)) return;
      const task = send()
        .then(() => undefined)
        .catch(() => {
          this.options.logger?.warn({ component: 'push', kind }, 'verity: push fire point failed');
        })
        .finally(() => {
          this.active.delete(task);
        });
      this.active.add(task);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }

  private cancelPermissions(sessionId: string, state: SessionFireState): void {
    for (const toolUseId of state.handledPermissions) {
      this.cancel(`permission:${sessionId}:${toolUseId}`);
    }
  }

  /** Keep terminal state briefly to collapse late result/status duplicates, then
   * evict it so a long-lived server does not retain every session it has seen. */
  private scheduleStateCleanup(sessionId: string, state: SessionFireState): void {
    const key = `cleanup:${sessionId}`;
    this.cancel(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (this.sessions.get(sessionId) === state && state.terminalHandled) {
        this.sessions.delete(sessionId);
      }
    }, this.debounceMs + TERMINAL_STATE_RETENTION_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }
}

export function createPushFirePoints(options: PushFirePointOptions): PushFirePoints {
  return new DefaultPushFirePoints(options);
}
