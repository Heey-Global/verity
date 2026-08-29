import type {
  AgentEvent,
  AgentLoopProposal,
  Attachment,
  BrokeredGrantChannel,
  ChoicesOption,
  RiskClass,
} from '@verity/events';

/**
 * The mobile transcript model — mirrors `slopus/happy`
 * `sources/sync/typesMessage.ts` (MIT), the shape Happy's renderer consumes.
 * The Verity reducer ({@link ../reducer}) produces these from canonical
 * `@verity/events` events, so when Happy's UI is vendored it renders our data
 * unchanged.
 *
 * Two deliberate Verity adaptations vs upstream:
 *  - `ModeSwitchMessage.event` carries OUR canonical {@link AgentEvent} (upstream
 *    uses Happy's own `typesRaw` event union, which we don't map onto). The
 *    `agent-event` renderer is reconciled when Happy's UI lands.
 *  - `createdAt` is the event's real persist time — the store row's `created_at`
 *    surfaced as epoch milliseconds on the WS/REST frame's `ts` (#32). When `ts`
 *    is absent (an older server during an asymmetric rollout) the reducer falls
 *    back to the event `seq` (a monotonic ordering proxy), the previous behaviour.
 */

export interface ToolCallPermission {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'canceled';
  reason?: string;
  mode?: string;
  allowedTools?: string[];
  decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
  date?: number;
}

export interface ToolCall {
  name: string;
  state: 'running' | 'completed' | 'error';
  input: unknown;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  description: string | null;
  result?: unknown;
  permission?: ToolCallPermission;
  /** For a `Skill` call: the SKILL.md body Claude Code injected after invoking it.
   * The reducer folds the `skill` event's text here so the card can reveal it on
   * expand (collapsed by default) instead of it leaking as a wall of chat prose. */
  skillBody?: string;
}

export interface UserTextMessage {
  kind: 'user-text';
  id: string;
  localId: string | null;
  createdAt: number;
  text: string;
  /** Operator-attached images (v1) sent with this prompt, rendered as thumbnails
   * in the bubble. Omitted when the turn had no attachments. */
  attachments?: Attachment[];
  /** Set ONLY on a client-side local echo (a Verity addition; the reducer never
   * sets it): the operator's message is rendered immediately on send, marked
   * `sending` until the canonical `prompt` event replaces it — or `failed` if the
   * send didn't get through, so the text stays recoverable. See
   * `SessionModel.pendingMessages`. */
  pending?: 'sending' | 'failed';
}

export interface AgentTextMessage {
  kind: 'agent-text';
  id: string;
  localId: string | null;
  createdAt: number;
  text: string;
  isThinking?: boolean;
  /** Set when this is a SUB-agent's output — the id of the spawning Agent/Task
   * tool. The transcript nests it under that dispatch's collapsed card. */
  parentToolId?: string;
}

export interface ToolCallMessage {
  kind: 'tool-call';
  id: string;
  localId: string | null;
  createdAt: number;
  tool: ToolCall;
  children: Message[];
  /** Set when this tool call was made BY a sub-agent — the id of the spawning
   * Agent/Task tool. Nested under that dispatch's collapsed card. */
  parentToolId?: string;
}

export interface ModeSwitchMessage {
  kind: 'agent-event';
  id: string;
  createdAt: number;
  event: AgentEvent;
}

/**
 * A Quick-Action decision point (issue #97) — a Verity addition with no upstream
 * Happy analogue. Produced by the reducer from a canonical `choices` event; the
 * screen renders `options` as tappable chips, sending the chosen `label` (or the
 * comma-joined labels when `multiSelect`) as the next turn. `question` is the
 * agent's prompt text, if it supplied one.
 */
export interface ChoicesMessage {
  kind: 'choices';
  id: string;
  createdAt: number;
  question?: string;
  options: ChoicesOption[];
  multiSelect: boolean;
}

export interface AgentLoopProposalMessage {
  kind: 'agent-loop-proposal';
  id: string;
  createdAt: number;
  proposal: AgentLoopProposal;
}

/**
 * A LIVE per-tool permission prompt (issue #149) — distinct from the post-hoc
 * `PermissionDenial` list folded off `result` (#26). The mid-turn runner (#27)
 * pauses the agent on a `can_use_tool` and emits a canonical `permission` event;
 * the reducer surfaces it as this pending state (NOT a transcript row — it's a
 * modal/banner the screen renders above the input). The operator answers
 * allow/deny and the app POSTs the decision to
 * `/sessions/:id/permissions/:toolUseId`. There is at most ONE pending at a time
 * (the turn is paused on it). It clears off the STREAM, not the decision POST: the
 * resulting events (the approved tool's `tool_call`/`tool_result`, the turn's
 * `result`/`interrupted`, or a new turn's `prompt`/`session`) dismiss it — the POST
 * itself never mutates this state (see `SessionModel.decidePermission`).
 */
export interface PendingPermission {
  /** The `tool_use_id` — the path key for the decision POST. */
  toolUseId: string;
  /** Canonical tool name the agent wants to run (e.g. `Bash`, `Write`). */
  tool: string;
  /** The tool input the agent proposed (rendered as a summary for the operator). */
  input: unknown;
  /** Risk class the backend assigned: `ask` always escalates to the operator. */
  riskClass: RiskClass;
  /** The event's persist time (epoch ms, #32) — for ordering/diagnostics. */
  createdAt: number;
  /**
   * Transport this prompt arrived on (ADR 0014 D3), which decides the standing grant
   * scopes the card may offer for a brokered-secret tool — `forever` is not one of
   * them on `acp`. Server-derived; absent on prompts from a server that predates it.
   */
  grantChannel?: BrokeredGrantChannel;
}

export type Message =
  | UserTextMessage
  | AgentTextMessage
  | ToolCallMessage
  | ModeSwitchMessage
  | ChoicesMessage
  | AgentLoopProposalMessage;
