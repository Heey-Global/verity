import type { AgentEvent, ChoicesPayload, RiskClass } from '@verity/events';

import type { SessionStatus } from './status.js';

/**
 * Inbox facts carried on the session summary, so an overview can answer a
 * session's question or permission without opening its transcript.
 *
 * Both read the same narrowed projection tail as the status badge, and both stop
 * at the most recent non-steered `prompt`. That keeps them inside the tail that
 * `projectionTailIsSelfContained` already proves sufficient: neither can need an
 * event older than the prompt that started the current turn.
 */

/** The latest `verity:choices` block a session is still waiting on. */
export type OpenChoices = ChoicesPayload;

/** One permission prompt the conductor still has parked, with enough of its
 * durable event for an overview to describe it. */
export interface PendingPermissionRequest {
  toolUseId: string;
  tool: string;
  riskClass: RiskClass;
  /** Session list only, per person: whether this prompt is for the requester. */
  addressedToViewer?: boolean;
  detached?: boolean;
  grantChannel?: 'acp';
  createdAt?: number;
  /** The tool input, or absent when it is larger than
   * {@link PERMISSION_INPUT_MAX_BYTES}; the client then sends the operator to
   * the session instead of deciding blind. */
  input?: unknown;
}

/**
 * Upper bound for a permission input carried on the summary.
 *
 * The session list is polled by every device, so a write of a large file must
 * not ride along with every summary. 4 KiB holds the inputs the overview can
 * summarize (a mail, an HTTP request, a secret name, a host) and drops bulky
 * ones, which need the full session card to judge anyway.
 */
export const PERMISSION_INPUT_MAX_BYTES = 4_096;

const ACTIVE: ReadonlySet<SessionStatus> = new Set(['running', 'crashed']);

/**
 * The choices block of the current turn, while nobody has answered it.
 *
 * Answering a choice is a new non-steered `prompt`, so the backward scan ends
 * there; a choices event found before reaching one is unanswered. A session that
 * is still working, or crashed, is not waiting on its last question, so neither
 * offers it. A steered prompt is mid-turn guidance and does not answer anything.
 */
export function openChoicesFromProjection(
  events: readonly AgentEvent[],
  status: SessionStatus,
  busy: boolean,
): OpenChoices | undefined {
  return liveOpenChoices(unansweredChoicesFromProjection(events), status, busy);
}

/** The live half of {@link openChoicesFromProjection}, for a log-derived block. */
export function liveOpenChoices(
  choices: OpenChoices | undefined,
  status: SessionStatus,
  busy: boolean,
): OpenChoices | undefined {
  return busy || ACTIVE.has(status) ? undefined : choices;
}

/** The log half of {@link openChoicesFromProjection}: the current turn's
 *  unanswered choices block, whatever the session is doing now. */
export function unansweredChoicesFromProjection(
  events: readonly AgentEvent[],
): OpenChoices | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.t === 'prompt') {
      if (event.steered === true) continue;
      return undefined;
    }
    if (event.t === 'choices') {
      return {
        options: event.options,
        ...(event.question !== undefined ? { question: event.question } : {}),
        ...(event.multiSelect !== undefined ? { multiSelect: event.multiSelect } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Describe each permission the conductor still has parked from its durable
 * `permission` event in the current turn.
 *
 * The conductor's live set decides WHICH prompts are open — an event alone can
 * be an already-answered card — and the event supplies what they ask. An id
 * without a matching event in the tail (a linked-session message approval, or a
 * prompt raised before a restart) is left out rather than guessed at; the plain
 * `pendingPermissions` list still carries it.
 */
export function pendingPermissionRequestsFromProjection(
  events: readonly AgentEvent[],
  pendingIds: readonly string[],
): PendingPermissionRequest[] {
  if (pendingIds.length === 0) return [];
  return pickPermissionRequests(currentTurnPermissionRequests(events), pendingIds);
}

/** The log half of {@link pendingPermissionRequestsFromProjection}: every
 *  permission the current turn raised, by tool-use id, newest event winning. */
export function currentTurnPermissionRequests(
  events: readonly AgentEvent[],
): Map<string, PendingPermissionRequest> {
  const found = new Map<string, PendingPermissionRequest>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.t === 'prompt' && event.steered !== true) break;
    if (event.t !== 'permission' || found.has(event.id)) continue;
    found.set(event.id, {
      toolUseId: event.id,
      tool: event.tool,
      riskClass: event.riskClass,
      ...(inputFits(event.input) ? { input: event.input } : {}),
    });
  }
  return found;
}

/** The live half: the requests among `found` the conductor still holds open. */
export function pickPermissionRequests(
  found: ReadonlyMap<string, PendingPermissionRequest>,
  pendingIds: readonly string[],
): PendingPermissionRequest[] {
  return pendingIds.flatMap((id) => {
    const request = found.get(id);
    return request === undefined ? [] : [request];
  });
}

function inputFits(input: unknown): boolean {
  if (input === undefined) return false;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return false;
  }
  return (
    serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= PERMISSION_INPUT_MAX_BYTES
  );
}

/**
 * The person the current turn runs for: the `initiatedBy` of its opening prompt,
 * which is whom the turn's questions and permission prompts are for. A steered
 * prompt is guidance inside that turn and does not change whose it is. The
 * overview passes a tail only when it holds an opening prompt and otherwise reads
 * the whole log (`projectionTailIsSelfContained`), so the latest opening prompt
 * found here is always the current turn's.
 */
export function requestInitiatorFromProjection(events: readonly AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.t !== 'prompt' || event.steered === true) continue;
    return event.initiatedBy?.userId;
  }
  return undefined;
}
