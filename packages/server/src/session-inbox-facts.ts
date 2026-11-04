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
  if (busy || ACTIVE.has(status)) return undefined;
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
  const wanted = new Set(pendingIds);
  const found = new Map<string, PendingPermissionRequest>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.t === 'prompt' && event.steered !== true) break;
    if (event.t !== 'permission' || !wanted.has(event.id) || found.has(event.id)) continue;
    found.set(event.id, {
      toolUseId: event.id,
      tool: event.tool,
      riskClass: event.riskClass,
      ...(inputFits(event.input) ? { input: event.input } : {}),
    });
  }
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
