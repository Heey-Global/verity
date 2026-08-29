import type { PermissionRequest } from '@verity/adapter-claude';
import type { AgentEvent, BrokeredGrantChannel, RiskClass } from '@verity/events';
import type { EventSink } from '@verity/store';
import type { EventBus } from './bus.js';

type SessionEvent = Extract<AgentEvent, { t: 'session' }>;

/**
 * The stream carried events but never a session init, so nothing the backend did
 * could be attributed to a session. The dominant cause is a `--resume` naming a
 * conversation the backend does not have: it prints "No conversation found with
 * session ID: …" on stderr and exits before the agent protocol names a session.
 *
 * The symptom alone does NOT identify that cause — a stream truncated after the
 * backend had already acted looks the same from here. The reason lives on stderr,
 * so a caller that acts on this error must key on that reason, never on the bare
 * symptom. On the ACP path the reason arrives on the `RunResult`'s `stderr` rather
 * than on this error: `runAcpTurn` catches whatever {@link SessionWriter.finish}
 * throws and returns it alongside the agent's own stderr.
 */
export class NoSessionInitError extends Error {
  override readonly name = 'NoSessionInitError';
}

const NO_SESSION_INIT_MESSAGE = /event\(s\) but no session init/;

/**
 * Recognize a {@link NoSessionInitError}, including one that crossed a process
 * boundary and arrived as a plain `Error` carrying only the message (the runner
 * transport reconstructs failures from their text).
 *
 * This reports the SYMPTOM only. It is not on its own grounds for re-running a
 * turn — see the class doc.
 */
export function isNoSessionInitFailure(error: unknown): boolean {
  if (error instanceof NoSessionInitError) return true;
  return error instanceof Error && NO_SESSION_INIT_MESSAGE.test(error.message);
}

export interface IngestHooks {
  /** Called once, the moment the session first binds (its id becomes known).
   * Awaited — return a promise to persist a leading event (e.g. the operator's
   * prompt) before any subsequent stream event. */
  onSession?: ((sessionId: string) => void | Promise<void>) | undefined;
  /** Fan-out seam: each event is published here AFTER it durably persists. */
  bus?: EventBus | undefined;
}

/**
 * The {@link RiskClass} for a tool that reached an interactive permission
 * prompt. By definition the runtime did NOT auto-approve it (else no prompt would
 * surface), so it always escalates to the operator (`ask`). A future per-tool
 * classifier would take the tool name and refine this; today it's a constant.
 */
const PERMISSION_RISK_CLASS: RiskClass = 'ask';

/**
 * Drives a single live session's canonical events into the durable store
 * (concept §5a). The first `session` event registers the session (or, on a
 * resume, re-attaches to the existing one); every event — including that
 * `session` event — is appended to the append-only log under its session id.
 *
 * Events that arrive before the session is bound (e.g. a leading `error`/`raw`
 * an adapter emitted instead of throwing, precisely so a malformed frame can't
 * abort the stream) are buffered, then flushed in order once the session binds,
 * so nothing is lost. {@link finish} surfaces a turn that ends without ever
 * establishing a session.
 */
export class SessionWriter {
  private sessionId: string | undefined;
  private boundBackendSessionId: string | undefined;
  private readonly pending: AgentEvent[] = [];

  constructor(
    private readonly store: EventSink,
    private readonly hooks: IngestHooks = {},
    private readonly storeSessionId?: string,
  ) {}

  /** The active session id, once a `session` event has been seen. */
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Persist durably, THEN publish to the bus — never broadcast an event that
   * didn't land. */
  private async persist(sessionId: string, event: AgentEvent): Promise<void> {
    const { seq, ts } = await this.store.appendEvent(sessionId, event);
    this.hooks.bus?.publish(sessionId, { seq, ts, event });
  }

  async write(event: AgentEvent): Promise<void> {
    let justBound = false;
    if (event.t === 'session') {
      const backendSessionId = event.id;
      if (this.storeSessionId !== undefined && this.storeSessionId !== event.id) {
        event = { ...event, id: this.storeSessionId };
      }
      justBound = await this.bindSession(event, backendSessionId);
    }
    if (this.sessionId === undefined) {
      // No session yet — can't persist without a session row (FK). Buffer until
      // the session binds rather than aborting on pre-init noise.
      this.pending.push(event);
      return;
    }
    await this.persist(this.sessionId, event);
    if (justBound) {
      // Fire AFTER the binding `session` event durably persists, so a hook that
      // appends a leading event (the conductor's operator-prompt) lands right
      // behind `session` and before any later stream event — `session` stays the
      // first canonical event, and the prompt precedes the agent's output.
      await this.hooks.onSession?.(this.boundBackendSessionId ?? this.sessionId);
    }
  }

  /**
   * Persist + fan out a `permission` event for an inbound permission prompt
   * (#27), so the transcript records that the operator was asked — independent of
   * the eventual allow/deny answer. Like every other event it needs a bound
   * session; a permission prompt always arrives after the session bind, but if one
   * somehow precedes it the event is buffered like any other pre-bind event and
   * flushed in order.
   */
  async writePermission(
    request: PermissionRequest,
    /** Transport the prompt arrived on, recorded so the approval card offers only the
     *  standing scopes that channel accepts (ADR 0014 D3). The caller knows it from the
     *  backend it is ingesting; it is never read off the prompt, which the agent wrote. */
    grantChannel: BrokeredGrantChannel,
  ): Promise<void> {
    await this.write({
      t: 'permission',
      id: request.toolUseId,
      tool: request.toolName,
      input: request.input,
      riskClass: PERMISSION_RISK_CLASS,
      grantChannel,
    });
  }

  /** Must be called once the stream ends. */
  async finish(): Promise<void> {
    if (this.sessionId === undefined && this.pending.length > 0) {
      const hasTerminalResult = this.pending.some((event) => event.t === 'result');
      if (this.storeSessionId !== undefined && hasTerminalResult) {
        const existing = await this.store.getSession(this.storeSessionId);
        if (existing !== undefined) {
          this.sessionId = this.storeSessionId;
          for (const buffered of this.pending) {
            await this.persist(this.sessionId, buffered);
          }
          this.pending.length = 0;
          return;
        }
      }
      throw new NoSessionInitError(
        `stream ended with ${String(this.pending.length)} event(s) but no session init`,
      );
    }
    return Promise.resolve();
  }

  /** Binds the session id (creating the row on first sight, validating the
   * worktree on resume) and flushes any pre-init buffered events. Returns whether
   * this call is the one that first bound the session, so {@link write} can fire
   * the `onSession` hook exactly once — after the `session` event itself lands. */
  private async bindSession(event: SessionEvent, backendSessionId = event.id): Promise<boolean> {
    const wasUnbound = this.sessionId === undefined;
    const existing = await this.store.getSession(event.id);
    if (existing) {
      // Resume: the session id must stay bound to the same worktree (§5a — two
      // agents must never resume the same session id into a different worktree).
      if (existing.worktree !== event.worktree) {
        throw new Error(
          `session ${event.id} is bound to worktree ${existing.worktree}; ` +
            `refusing to rebind it to ${event.worktree}`,
        );
      }
    } else {
      await this.store.createSession({
        sessionId: event.id,
        worktree: event.worktree,
        model: event.model,
      });
    }
    this.sessionId = event.id;
    this.boundBackendSessionId = backendSessionId;
    // Flush events buffered before the session bound (preserves stream order).
    for (const buffered of this.pending) {
      await this.persist(this.sessionId, buffered);
    }
    this.pending.length = 0;
    return wasUnbound;
  }
}
