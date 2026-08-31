import type {
  AgentEvent,
  AgentStatus,
  PermissionDenial,
  RateLimitWindow,
  UsageTotals,
} from '@verity/events';
import type {
  AgentTextMessage,
  ChoicesMessage,
  AgentLoopProposalMessage,
  Message,
  PendingPermission,
  ToolCallMessage,
  UserTextMessage,
} from './happy/message.js';
import type { StreamEventFrame } from './wire.js';

const MAX_TRACKED_RATE_LIMITS = 32;

export interface SessionState {
  sessionId: string | undefined;
  model: string | undefined;
  status: AgentStatus | undefined;
  messages: Message[];
  /** Live cumulative token usage across the session's completed turns (§13a). */
  usage: UsageTotals;
  /** Tools the session's turns requested but were denied (§5b). Each entry may
   * additionally carry `toolUseId` + `input` for correlation when the backend
   * surfaces them (#26). */
  permissionDenials: PermissionDenial[];
  /** Latest provider rate-limit status (§13a), or undefined until one arrives. The
   * SDK emits a `rate_limit` event per turn; we keep only the latest as state
   * (the screen shows a single banner when `status !== 'allowed'`) rather than a
   * per-turn transcript row, which was noise. */
  rateLimit:
    | {
        status: string;
        resetsAt: number;
        window: RateLimitWindow;
        usedPercent?: number;
        providerLabel: string;
      }
    | undefined;
  /**
   * The LIVE per-tool permission prompt the in-flight turn is paused on (#149), or
   * `undefined` when none is pending. Derived from the canonical `permission` event
   * the mid-turn runner emits (#27); the screen renders it as an approve/deny prompt
   * above the input and POSTs the operator's decision. At most one is pending at a
   * time (the turn blocks on it). Cleared when the tool runs (a matching `tool_call`/
   * `tool_result` arrives), the turn ends (`result`/`interrupted`), or a new turn
   * starts (`prompt`/fresh `session`). DISTINCT from `permissionDenials` (the
   * post-hoc denied-tool list folded off `result`, #26) — that's a record of what was
   * blocked; this is the live decision point. */
  pendingPermission: PendingPermission | undefined;
  /**
   * True while a turn is in flight (issue #79) — derived from the stream so the
   * screen can show a Stop button (the adapter emits no `status` events live, so
   * `status` above stays undefined on the live stream). Set true when a turn
   * starts (`prompt` from the operator, or the fresh-session `session` bind) and
   * false on a terminal event (`result` or `interrupted`). A `result` that lands
   * while a background task (sub-agent / `run_in_background`) is still open does
   * NOT clear it — that `result` is an intra-turn checkpoint and the backend
   * re-invokes with a later `result` once the task finishes. A canonical `error`
   * is a mid-turn adapter diagnostic, NOT a turn terminator, so it does NOT clear
   * this. After replaying a finished session it lands false (the last turn ended
   * in a `result`).
   */
  running: boolean;
}

const STALE_CLAUDE_RESUME_ERROR = /No conversation found with session ID/i;

function shouldRenderAgentEvent(event: AgentEvent): boolean {
  return !(
    event.t === 'error' &&
    event.kind === 'claude_result_error' &&
    STALE_CLAUDE_RESUME_ERROR.test(event.message)
  );
}

/**
 * Folds a session's canonical event stream into the mobile transcript model
 * ({@link Message}[]) the forked Happy renderer consumes. Stateful: streaming
 * `text`/`thinking` deltas accumulate into a single `agent-text` message until a
 * block boundary (any other event) closes it, so the transcript reads as whole
 * blocks rather than per-delta fragments.
 *
 * Coalescing note: the canonical `text` event carries no block id, so
 * consecutive `text` events (whether streaming deltas of one block or distinct
 * adjacent text blocks) DELIBERATELY merge into one `agent-text` message — there
 * is no signal to split them, and one continuous message reads better than
 * fragments. `thinking` does carry a `blockId`, so thinking blocks stay
 * distinct. (If per-text-block separation is ever needed, the adapter must emit
 * a text block boundary — a server-side change.)
 *
 * Handles `session`/`status`/`text`/`thinking`, `tool_call`/`tool_result`
 * correlation (a result updates its call's message in place, keyed by tool id),
 * and `result` (folds `usage` + `permissionDenials` into the live session
 * totals — the client-side mirror of the server's `aggregateUsage`). Lifecycle
 * events `compaction`/`error`/`raw` become standalone `agent-event` messages
 * (rendered via the `ui/agentEvent` descriptor); `rate_limit` is kept as the
 * latest session state (`rateLimit`) for the screen's banner, not a row. A
 * `choices` event (issue #97) becomes a `choices` message the screen renders as
 * tappable Quick-Action chips.
 *
 * A live `permission` event (issue #149, emitted by the mid-turn streaming-stdin
 * runner #27) becomes the `pendingPermission` state — the per-tool approve/deny
 * prompt the screen renders above the input; it clears when the tool runs, the turn
 * ends, or a new turn starts. (Distinct from `permissionDenials`, the post-hoc
 * denied-tool list folded off `result` #26.)
 */
export class SessionReducer {
  private _sessionId: string | undefined;
  private _model: string | undefined;
  private _status: AgentStatus | undefined;
  private readonly _messages: Message[] = [];
  private readonly _usage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 0,
  };
  private readonly _permissionDenials: PermissionDenial[] = [];
  private _rateLimit: SessionState['rateLimit'];
  private readonly _rejectedRateLimits = new Map<string, NonNullable<SessionState['rateLimit']>>();
  // The live per-tool permission prompt the turn is paused on (#149), or undefined.
  // At most one pending at a time (the turn blocks on it). See SessionState.pendingPermission.
  private _pendingPermission: PendingPermission | undefined;
  // True while a turn is in flight (issue #79); see SessionState.running.
  private _running = false;
  // Background tasks (sub-agents / run_in_background) still open in the current
  // turn, keyed by task id. A `run_in_background` dispatch returns its tool_call
  // immediately, so the turn's first `result` fires while the task runs on and the
  // backend re-invokes with a later `result` once it finishes. While any task is
  // open, an intervening `result` must NOT clear `_running` — see the `result`
  // case. Cleared on a new turn starting and on a terminal `status` — but NOT on a
  // `result`, which while a task is open is a checkpoint rather than the turn's end.
  private readonly _openTasks = new Set<string>();
  // The open streaming block, if the last event was text/thinking. `blockId`
  // null = a `text` block; non-null = a `thinking` block keyed by its blockId.
  private active: { msg: AgentTextMessage; blockId: string | null } | null = null;
  // tool id → its message, so a `tool_result` can update the matching `tool_call`.
  private readonly toolsById = new Map<string, ToolCallMessage>();
  // The most-recent open `Skill` tool call awaiting its injected body. Claude Code
  // delivers the SKILL.md body as a synthetic `user` turn (→ `skill` event) right
  // after the Skill tool_call + its ack, with no id linking the two on the stream —
  // so we correlate by position: set here when a Skill call opens, consumed by the
  // next `skill` event, and cleared on any intervening boundary so a later stray
  // synthetic turn can't attach to a stale call.
  private _pendingSkillToolId: string | null = null;
  // Skill tool ids whose ack (`tool_result`) has landed but whose work runs on as
  // the rest of the turn (a skill launches sub-agents, then reports). The Skill tool
  // otherwise flips to `completed` the instant its "Launching skill…" ack arrives,
  // so its card would never pulse. Keep those cards `running` until the turn truly
  // ends (its `result` with no open background tasks), then settle them.
  private readonly _openSkillTools = new Set<string>();

  /**
   * Fold one canonical event into the transcript. `seq` is the monotonic order
   * key (ids, dedup, accumulation); `ts` is the real persist time (epoch ms, the
   * store's `created_at`, #32) used for the display `createdAt`/`startedAt`/
   * `completedAt`. `ts` defaults to `seq` so a frame WITHOUT it (older server /
   * asymmetric rollout) falls back to the previous `seq`-as-time proxy.
   */
  apply(seq: number, event: AgentEvent, ts: number = seq): void {
    // The Skill→body correlation survives ONLY the [Skill `tool_call`] →
    // [`tool_result`] → [`skill`] sequence: any other event invalidates a pending
    // body so a stale one can't capture a later synthetic turn (a new turn, an
    // interrupt, a mid-turn permission/choices prompt, agent prose, …). `tool_call`
    // is excluded because `openTool` sets/clears it based on the tool name.
    if (event.t !== 'tool_result' && event.t !== 'skill' && event.t !== 'tool_call') {
      this._pendingSkillToolId = null;
    }
    switch (event.t) {
      case 'session':
        this._sessionId = event.id;
        this._model = event.model;
        // A fresh-session bind is the start of its first turn (#79); a new turn
        // can't carry a stale permission prompt from a prior one (#149).
        this._pendingPermission = undefined;
        this._running = true;
        this._openTasks.clear(); // a fresh turn starts with no outstanding tasks
        break;
      case 'status':
        this._status = event.state;
        // A `completed`/`crashed` status is the AUTHORITATIVE turn-end marker: a
        // backend emits it only when a turn truly ends (for ACP, once the prompt
        // settles; see `acp-backend.ts`). So clear `running` and drain the open-task
        // set UNCONDITIONALLY here — mirroring the server's `deriveSessionStatus`, which
        // returns on a `status` regardless of open tasks. (The `result` case keeps its
        // `_openTasks` guard because an intra-turn `result` while a task runs is a
        // checkpoint, not the end — but a terminal `status` never is.) The prior
        // `_openTasks.size === 0` guard here made `running` STICK whenever the reducer
        // missed a `task ended` (a dropped/streamed-past event): the set never drained,
        // so the turn-end status was ignored and the indicator hung forever.
        if (event.state === 'completed' || event.state === 'crashed') {
          this.active = null; // turn end closes the open streaming block (mirror `result`)
          this._running = false;
          this._openTasks.clear(); // the turn ended; its background tasks are over
          this.settleOpenSkillTools(ts);
          this._pendingPermission = undefined;
        }
        break;
      case 'text':
        this.appendText(seq, ts, event.delta, event.parentToolId);
        break;
      case 'notice':
        this.active = null;
        if (event.role === 'operator') {
          this._messages.push({
            kind: 'user-text',
            id: `notice-${String(seq)}`,
            localId: event.clientRequestId ?? null,
            createdAt: ts,
            text: event.text,
          });
        } else {
          this._messages.push({
            kind: 'agent-text',
            id: `notice-${String(seq)}`,
            localId: null,
            createdAt: ts,
            text: event.text,
          });
        }
        break;
      case 'prompt': {
        // The operator's steering prompt → a user-text message. A new turn
        // closes any open agent streaming block and marks the session running (#79).
        // It also supersedes any unanswered permission prompt (#149) — the turn it
        // belonged to is over once a fresh prompt is dispatched.
        this.active = null;
        this._pendingPermission = undefined;
        this._running = true;
        this._openTasks.clear(); // a fresh turn starts with no outstanding tasks
        const msg: UserTextMessage = {
          kind: 'user-text',
          id: `user-${String(seq)}`,
          localId: null,
          createdAt: ts,
          text: event.text,
          ...(event.attachments && event.attachments.length > 0
            ? { attachments: event.attachments }
            : {}),
        };
        this._messages.push(msg);
        break;
      }
      case 'thinking':
        this.appendThinking(seq, ts, event.blockId, event.delta, event.parentToolId);
        break;
      case 'skill':
        this.attachSkillBody(event.text);
        break;
      case 'tool_call':
        // An approved tool now runs: clear the matching permission prompt (#149).
        this.clearPermissionFor(event.id);
        this.openTool(seq, ts, event.id, event.name, event.input, event.parentToolId);
        break;
      case 'tool_result':
        if (this._pendingSkillToolId !== null && event.id !== this._pendingSkillToolId) {
          this._pendingSkillToolId = null;
        }
        // A result for the parked tool also resolves its prompt (e.g. the tool ran,
        // or a deny short-circuited to an error result for that id) (#149).
        this.clearPermissionFor(event.id);
        this.completeTool(ts, event.id, event.output, event.isError);
        break;
      case 'permission':
        // The mid-turn runner paused on a tool (#27/#149): surface the live
        // approve/deny prompt. Closes the open streaming block like any boundary
        // event. `id` is the tool_use_id (the decision POST's path key).
        this.active = null;
        this._pendingPermission = {
          toolUseId: event.id,
          tool: event.tool,
          input: event.input,
          riskClass: event.riskClass,
          createdAt: ts,
          ...(event.grantChannel !== undefined ? { grantChannel: event.grantChannel } : {}),
        };
        break;
      case 'result':
        this.active = null; // turn end closes the open block
        // A `result` while a background task is still open is an intra-turn
        // checkpoint, not the turn's end — the backend re-invokes with a later
        // `result` once the task finishes. Only clear `running` when nothing is
        // outstanding, so the screen doesn't flip to "stopped" mid-turn (#79).
        if (this._openTasks.size === 0) {
          this._running = false;
          // The turn truly ended — settle Skill cards kept pulsing during the review.
          this.settleOpenSkillTools(ts);
        }
        // The turn ended — no permission can still be pending (the runner
        // fail-safe-denies any un-answered prompt before the turn settles) (#149).
        this._pendingPermission = undefined;
        this.accrueResult(event.usage, event.permissionDenials);
        break;
      case 'task':
        // Background task lifecycle (sub-agent / run_in_background). Track the open
        // set so an intra-turn `result` doesn't clear `running` (see the `result`
        // case). Not a transcript row and not a streaming boundary — leave `active`
        // untouched so it doesn't fragment an open text/thinking block.
        if (event.phase === 'started') this._openTasks.add(event.id);
        else if (event.phase === 'ended') this._openTasks.delete(event.id);
        break;
      case 'rate_limit': {
        // Track the latest provider rate-limit status as session state (the screen
        // shows a single banner only when it's not `allowed`) — NOT a per-turn
        // transcript row, which was noise. Closes the open block like any other
        // boundary event.
        this.active = null;
        // This single state slot drives the provider-wide session banner. Keep
        // model-scoped events in the canonical log/detail projection, but do not
        // let them replace or clear the all-models live banner.
        if (event.scope !== undefined && event.scope !== 'all_models') break;
        const observedSeconds = Math.floor(ts / 1000);
        for (const [storedKey, stored] of this._rejectedRateLimits) {
          if (stored.resetsAt <= observedSeconds) this._rejectedRateLimits.delete(storedKey);
        }
        const next = {
          status: event.status,
          resetsAt: event.resetsAt,
          window: event.window,
          ...(event.usedPercent !== undefined ? { usedPercent: event.usedPercent } : {}),
          providerLabel: event.providerLabel ?? 'Claude',
        };
        const key = `${next.providerLabel}\u0000${next.window}`;
        if (next.status === 'allowed') this._rejectedRateLimits.delete(key);
        else this._rejectedRateLimits.set(key, next);
        while (this._rejectedRateLimits.size > MAX_TRACKED_RATE_LIMITS) {
          let oldestKey: string | undefined;
          let oldestReset = Number.POSITIVE_INFINITY;
          for (const [storedKey, stored] of this._rejectedRateLimits) {
            if (stored.resetsAt < oldestReset) {
              oldestKey = storedKey;
              oldestReset = stored.resetsAt;
            }
          }
          if (oldestKey === undefined) break;
          this._rejectedRateLimits.delete(oldestKey);
        }
        this._rateLimit = this._rejectedRateLimits.values().next().value ?? next;
        break;
      }
      case 'choices': {
        // A decision point (issue #97) → its own message the screen renders as
        // tappable chips. Closes the open streaming block like any boundary event.
        this.active = null;
        const msg: ChoicesMessage = {
          kind: 'choices',
          id: `choices-${String(seq)}`,
          createdAt: ts,
          ...(event.question !== undefined ? { question: event.question } : {}),
          options: event.options.map((o) => ({ ...o })),
          multiSelect: event.multiSelect ?? false,
        };
        this._messages.push(msg);
        break;
      }
      case 'agent_loop_proposal': {
        this.active = null;
        const msg: AgentLoopProposalMessage = {
          kind: 'agent-loop-proposal',
          id: `agent-loop-proposal-${String(seq)}`,
          createdAt: ts,
          proposal: event.proposal,
        };
        this._messages.push(msg);
        break;
      }
      case 'interrupted':
        // The operator stopped the turn (#79): a terminal marker that ENDS the
        // turn. Render as an `agent-event` row, clear the running flag, settle any
        // pulsing Skill card, and drop any unanswered permission prompt — the turn
        // it belonged to is over (#149).
        this._running = false;
        this.settleOpenSkillTools(ts);
        this._pendingPermission = undefined;
        this.emitAgentEvent(seq, ts, event);
        break;
      case 'merged':
        // The operator merged the session's PR: a transcript-only "Merged PR #N"
        // marker (no turn, no agent reply). Render it as an `agent-event` row. Does
        // NOT touch `running`: a merge is an out-of-band operator action, so the marker
        // neither starts nor ends a turn. It CAN land mid-turn (the operator may merge
        // while the agent is streaming); like the other agent-event markers it then
        // closes the open text block, so the reply renders as two bubbles around the
        // marker — the honest chronological placement of when the merge happened.
        this.emitAgentEvent(seq, ts, event);
        break;
      case 'compaction':
      case 'error':
      case 'raw':
        // Lifecycle/system events render as their own `agent-event` message
        // (Happy's AgentEventBlock); they also close the open streaming block.
        // These happen MID-turn and do NOT end it — in particular `error` is the
        // adapter's per-line/per-block diagnostic (a corrupt NDJSON line, schema
        // drift), not a turn terminator; the stream and the turn continue. A real
        // run failure surfaces via the conductor's `onTurnError` log, not a
        // canonical `error` event. So none of these clear the running flag.
        if (shouldRenderAgentEvent(event)) this.emitAgentEvent(seq, ts, event);
        break;
      default:
        // tool_call_start is rendered in a later slice. Any such event closes the
        // open streaming block so the next text/thinking delta starts a fresh message.
        this.active = null;
    }
  }

  applyFrame(frame: StreamEventFrame): void {
    // `ts` is optional on the wire (#32, back-compat): when absent, `apply`
    // defaults it to `seq` — the previous `seq`-as-time proxy.
    this.apply(frame.seq, frame.event, frame.ts);
  }

  private appendText(seq: number, ts: number, delta: string, parentToolId?: string): void {
    // Coalesce only within the same context: a top-level delta must not merge into
    // an open SUB-agent block (or vice-versa), or the two would render as one.
    if (
      this.active &&
      this.active.blockId === null &&
      this.active.msg.parentToolId === parentToolId
    ) {
      this.active.msg.text += delta;
      return;
    }
    const msg: AgentTextMessage = {
      kind: 'agent-text',
      id: `text-${String(seq)}`,
      localId: null,
      createdAt: ts,
      text: delta,
      ...(parentToolId !== undefined ? { parentToolId } : {}),
    };
    this._messages.push(msg);
    this.active = { msg, blockId: null };
  }

  private appendThinking(
    seq: number,
    ts: number,
    blockId: string,
    delta: string,
    parentToolId?: string,
  ): void {
    if (
      this.active &&
      this.active.blockId === blockId &&
      this.active.msg.parentToolId === parentToolId
    ) {
      this.active.msg.text += delta;
      return;
    }
    // Headless `claude -p` delivers thinking blocks with an EMPTY body (only a
    // signature, kept for resume) — the content isn't exposed in the stream. So a
    // new thinking block with no text would render a "Thinking" chip that expands
    // to nothing (pure noise) AND, as its own message, break a run of tool calls
    // into separate cards. Drop it: emit no message, just close any open block
    // (a boundary), exactly like an unrendered event. A non-empty thinking block
    // (e.g. if a future runtime exposes the content) still renders — it falls
    // through to create the message below as normal.
    if (delta.trim().length === 0) {
      this.active = null;
      return;
    }
    const msg: AgentTextMessage = {
      kind: 'agent-text',
      // Keyed by `seq` (unique per event), not `blockId`: a blockId that
      // reappears after a boundary event would otherwise yield a duplicate id
      // (React-key collision in the renderer). Accumulation keys off the live
      // `active.blockId`, not this id, so uniqueness here is free.
      id: `think-${String(seq)}`,
      localId: null,
      createdAt: ts,
      text: delta,
      isThinking: true,
      ...(parentToolId !== undefined ? { parentToolId } : {}),
    };
    this._messages.push(msg);
    this.active = { msg, blockId };
  }

  private openTool(
    _seq: number,
    ts: number,
    id: string,
    name: string,
    input: unknown,
    parentToolId?: string,
  ): void {
    this.active = null; // a tool boundary closes any open text/thinking block
    // Track a `Skill` call so the injected body that follows (a `skill` event) can
    // fold into this card; any OTHER tool means that body isn't coming next.
    this._pendingSkillToolId = name === 'Skill' ? id : null;
    const msg: ToolCallMessage = {
      kind: 'tool-call',
      id: `tool-${id}`,
      localId: null,
      createdAt: ts,
      tool: {
        name,
        state: 'running',
        input,
        createdAt: ts,
        startedAt: ts,
        completedAt: null,
        description: null,
      },
      children: [],
      ...(parentToolId !== undefined ? { parentToolId } : {}),
    };
    this._messages.push(msg);
    this.toolsById.set(id, msg);
  }

  /** Clear the live permission prompt (#149) iff it's the one for this tool id — so
   * the matching `tool_call`/`tool_result` (the parked tool actually running, or its
   * deny short-circuiting to an error result) dismisses it, while an unrelated tool's
   * event leaves a still-pending prompt for a DIFFERENT tool untouched. */
  private clearPermissionFor(id: string): void {
    if (this._pendingPermission?.toolUseId === id) this._pendingPermission = undefined;
  }

  private completeTool(ts: number, id: string, output: unknown, isError: boolean): void {
    this.active = null;
    const msg = this.toolsById.get(id);
    if (!msg) return; // orphan result with no matching call — ignore, don't crash
    msg.tool.result = output;
    if (msg.tool.name === 'Skill' && !isError) {
      // A skill's "Launching skill…" ack lands immediately, but the review runs on
      // as the rest of the turn. Keep the card `running` (pulsing) until the turn
      // settles — see the `_openSkillTools` flush in the `result` case. The result
      // is still recorded above; only the state/timestamp wait.
      this._openSkillTools.add(id);
      return;
    }
    msg.tool.state = isError ? 'error' : 'completed';
    msg.tool.completedAt = ts;
  }

  /** Settle any Skill cards held `running` across the turn ({@link _openSkillTools})
   * once the turn truly ends — mirrors the `_running` clear (no open background
   * tasks), so a card stops pulsing exactly when the session does. */
  private settleOpenSkillTools(ts: number): void {
    for (const id of this._openSkillTools) {
      const msg = this.toolsById.get(id);
      if (msg && msg.tool.state === 'running') {
        msg.tool.state = 'completed';
        msg.tool.completedAt = ts;
      }
    }
    this._openSkillTools.clear();
  }

  /** Fold a skill's injected body into the `Skill` card it belongs to (correlated
   * by {@link _pendingSkillToolId}). A `skill` event with no pending call — a
   * non-skill synthetic turn ("Continue…", a tool-retry nudge) that reached the
   * adapter's synthetic path — renders nothing, preserving the no-leak guarantee. */
  private attachSkillBody(text: string): void {
    const id = this._pendingSkillToolId;
    this._pendingSkillToolId = null; // consumed (or dropped): one body per call
    if (id === null) return;
    // An empty/whitespace body (e.g. a preamble-only synthetic turn) carries
    // nothing to reveal — leave `skillBody` unset so the card isn't made pointlessly
    // expandable with a blank detail pane.
    if (text.trim().length === 0) return;
    const msg = this.toolsById.get(id);
    if (msg) msg.tool.skillBody = text;
  }

  /** Fold a turn's `result` into the live session totals — the client-side
   * mirror of the server's `aggregateUsage` (§13a), so the UI shows running
   * token cost + denied tools without a REST round-trip. */
  private accrueResult(
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    },
    permissionDenials: readonly PermissionDenial[] | undefined,
  ): void {
    this._usage.inputTokens += usage.inputTokens;
    this._usage.outputTokens += usage.outputTokens;
    this._usage.cacheReadTokens += usage.cacheReadTokens;
    this._usage.cacheCreationTokens += usage.cacheCreationTokens;
    this._usage.turns += 1;
    if (permissionDenials) this._permissionDenials.push(...permissionDenials);
  }

  /** Push a lifecycle/system event as a standalone `agent-event` message, closing
   * the open streaming block. The canonical event is carried verbatim; the UI
   * turns it into a display descriptor (see `ui/agentEvent`). */
  private emitAgentEvent(seq: number, ts: number, event: AgentEvent): void {
    this.active = null;
    this._messages.push({
      kind: 'agent-event',
      id: `event-${String(seq)}`,
      createdAt: ts,
      event,
    });
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }
  get model(): string | undefined {
    return this._model;
  }
  get status(): AgentStatus | undefined {
    return this._status;
  }
  get messages(): readonly Message[] {
    return this._messages;
  }
  get usage(): Readonly<UsageTotals> {
    return this._usage;
  }
  get permissionDenials(): readonly PermissionDenial[] {
    return this._permissionDenials;
  }
  get pendingPermission(): PendingPermission | undefined {
    return this._pendingPermission ? { ...this._pendingPermission } : undefined;
  }
  get running(): boolean {
    return this._running;
  }

  clearRateLimit(): void {
    this._rejectedRateLimits.clear();
    this._rateLimit = undefined;
  }

  /** Drop the live prompt for `toolUseId` once the SERVER has settled it — the
   * decision POST returned `decided: true` (the runner consumed the allow/deny) or
   * 404 (nothing pending under that id any more). In both cases the card can never
   * become actionable again, so it must not wait for a stream event to dismiss it:
   * a turn that dies between the prompt and its `tool_call`/`tool_result` never
   * emits one, leaving an "approve/deny" card the operator taps forever. */
  resolvePermission(toolUseId: string): void {
    const wasCurrent = this._pendingPermission?.toolUseId === toolUseId;
    this.clearPermissionFor(toolUseId);
    if (wasCurrent && this._status === 'awaiting_input') {
      this._status = 'running';
      this._running = true;
    }
  }

  get state(): SessionState {
    return {
      sessionId: this._sessionId,
      model: this._model,
      status: this._status,
      messages: [...this._messages],
      usage: { ...this._usage },
      permissionDenials: [...this._permissionDenials],
      rateLimit: this._rateLimit ? { ...this._rateLimit } : undefined,
      pendingPermission: this._pendingPermission ? { ...this._pendingPermission } : undefined,
      running: this._running,
    };
  }
}

/** Reduce a sequence of event frames into a session's state (convenience). */
export function reduceFrames(frames: Iterable<StreamEventFrame>): SessionState {
  const reducer = new SessionReducer();
  for (const frame of frames) reducer.applyFrame(frame);
  return reducer.state;
}
