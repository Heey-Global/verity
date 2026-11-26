import {
  ASSISTANT_APPROVAL_INPUT_MAX_BYTES,
  ASSISTANT_HANDOFF_DECLINED,
  ASSISTANT_TOOL,
  assistantMessageText,
  parseChoicesBlock,
  type AgentEvent,
  type AssistantApproval,
  type AssistantConversation,
  type AssistantConversationItem,
  type AssistantQuestion,
} from '@verity/events';
import type { AssistantHandoffResult, SequencedEvent } from '@verity/store';

import type { SessionStatus } from './status.js';

/** Items a device receives; older ones stay in the session transcript. */
const ASSISTANT_CONVERSATION_ITEMS = 40;

/** Matches a gateway tool by its bare name and by the `mcp__server__tool` form Claude uses. */
const isTool = (name: string, tool: string) => name === tool || name.endsWith(`__${tool}`);

export interface AssistantSessionFacts {
  status: SessionStatus;
  busy: boolean;
  /** Whether the session summary still reports its latest choices as unanswered. */
  choicesOpen: boolean;
  /** Approvals the conductor has parked, from the session summary. */
  approvals: readonly { toolUseId: string; tool: string }[];
}

type Projection = Omit<AssistantConversation, 'availability' | 'sessionId'>;

/**
 * The conversation projection of the assistant session's newest events.
 *
 * Ids derive from event sequence numbers, so they are stable across reads and
 * devices: a question keeps its id until it is answered, and an answer naming an
 * older id is recognised as stale. Open-or-answered comes from the session
 * summary, which already knows whether a later prompt answered the choices.
 */
export function projectAssistantConversation(
  events: readonly SequencedEvent[],
  facts: AssistantSessionFacts,
  maxItems = ASSISTANT_CONVERSATION_ITEMS,
): Projection {
  const items: AssistantConversationItem[] = [];
  const tools = new Map<string, number>();
  let reply: { id: string; at: number; text: string } | undefined;
  let choices: { seq: number; event: Extract<AgentEvent, { t: 'choices' }> } | undefined;
  /** Each approval's request, from its `permission` event, by approval id. */
  const requested = new Map<string, unknown>();
  let failed = false;
  /** The user's latest message, timed until the turn it started ends. */
  let timed: Extract<AssistantConversationItem, { kind: 'message' }> | undefined;
  const reacted = (ts: number) => {
    if (timed === undefined || timed.timing?.firstMs !== undefined) return;
    timed.timing = { ...timed.timing, firstMs: Math.max(0, ts - timed.at) };
  };

  const closeReply = () => {
    if (reply === undefined) return;
    const text = parseChoicesBlock(reply.text).text.trim();
    if (text.length > 0) items.push({ kind: 'reply', id: reply.id, at: reply.at, text });
    reply = undefined;
  };

  for (const { seq, ts, event } of events) {
    switch (event.t) {
      case 'prompt': {
        // A linked peer's message is not something the user said.
        if (event.peer !== undefined) break;
        closeReply();
        failed = false;
        const text = assistantMessageText(event.text).trim();
        timed = undefined;
        if (text.length > 0) {
          timed = { kind: 'message', id: `m-${String(seq)}`, at: ts, text };
          items.push(timed);
        }
        break;
      }
      case 'text':
        if (event.parentToolId !== undefined) break;
        reacted(ts);
        reply ??= { id: `r-${String(seq)}`, at: ts, text: '' };
        reply.text += event.delta;
        break;
      case 'tool_call': {
        if (event.parentToolId !== undefined) break;
        reacted(ts);
        const item = toolItem(event.name, event.input, `t-${String(seq)}`, ts);
        if (item === undefined) break;
        closeReply();
        tools.set(event.id, items.length);
        items.push(item);
        break;
      }
      case 'tool_result': {
        const index = tools.get(event.id);
        const item = index === undefined ? undefined : items[index];
        if (item?.kind === 'task') item.state = event.isError ? 'failed' : 'saved';
        if (item?.kind === 'assignment') {
          item.state = event.isError ? 'failed' : 'sent';
          const target = event.isError ? undefined : handoffTarget(event.output);
          if (target !== undefined) item.sessionId = target;
          if (event.isError && declinedOnCard(event.output)) item.declined = true;
        }
        if (item?.kind === 'meeting') item.state = event.isError ? 'failed' : 'ready';
        break;
      }
      case 'permission':
        requested.set(event.id, event.input);
        break;
      case 'choices':
        choices = { seq, event };
        break;
      case 'result':
        if (timed !== undefined)
          timed.timing = { ...timed.timing, doneMs: Math.max(0, ts - timed.at) };
        timed = undefined;
        break;
      case 'error':
        reacted(ts);
        closeReply();
        failed = true;
        items.push({ kind: 'error', id: `e-${String(seq)}`, at: ts, text: event.message });
        break;
      default:
        break;
    }
  }
  closeReply();

  const question: AssistantQuestion | null =
    facts.choicesOpen && choices !== undefined
      ? {
          id: `q-${String(choices.seq)}`,
          ...(choices.event.question !== undefined ? { question: choices.event.question } : {}),
          options: choices.event.options.map((option) => ({
            label: option.label,
            ...(option.recommended === true ? { recommended: true } : {}),
          })),
          multiSelect: choices.event.multiSelect === true,
        }
      : null;
  // One budget for all of them: the conversation is read on every change, and several
  // waiting approvals must not multiply it. One that no longer fits goes without its input,
  // and the device sends the user to the session for it.
  let budget = ASSISTANT_APPROVAL_INPUT_MAX_BYTES;
  const approvals = facts.approvals.map((approval): AssistantApproval => {
    const input = requested.get(approval.toolUseId);
    const size = inputBytes(input);
    const carried = size !== undefined && size <= budget;
    if (carried) budget -= size;
    return {
      id: approval.toolUseId,
      tool: approval.tool,
      ...(carried ? { input } : {}),
    };
  });
  linkHandoffApprovals(items, approvals);
  const working = facts.busy || facts.status === 'running';
  return {
    revision: events.at(-1)?.seq ?? 0,
    state:
      approvals.length > 0 || question !== null
        ? 'needs_you'
        : working
          ? 'working'
          : failed || facts.status === 'crashed'
            ? 'failed'
            : 'idle',
    items: items.slice(-maxItems),
    question,
    approvals,
  };
}

/** The sessions the conversation's handoff cards went to. */
export function handoffTargets(items: readonly AssistantConversationItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === 'assignment' && item.sessionId !== undefined ? [item.sessionId] : [],
  );
}

/** Puts each recorded result on its handoff card. A repeated handoff to one session answers
 *  only its newest card, since the record holds the result of the newest briefing. */
export function attachHandoffResults(
  items: AssistantConversationItem[],
  recorded: readonly AssistantHandoffResult[],
): void {
  const results = new Map(recorded.map((result) => [result.target_session_id, result]));
  for (const item of [...items].reverse()) {
    if (item.kind !== 'assignment' || item.sessionId === undefined) continue;
    const result = results.get(item.sessionId);
    if (result === undefined) continue;
    results.delete(item.sessionId);
    item.result = {
      delivered: result.delivered,
      summary: result.summary,
      ...(result.blocker === null ? {} : { blocker: result.blocker }),
      at: result.at.getTime(),
    };
  }
}

/**
 * Hands each waiting handoff approval to its card, so the card is decided in place.
 *
 * The gateway mints its own approval id, so the tool call's id cannot name it. The
 * card is the newest still-pending handoff with the approval's title: a handoff
 * waits on its approval before it can answer, and one turn rarely holds two
 * pending handoffs, let alone two with one title. Without a title match the
 * approval stays a card of its own rather than land on the wrong handoff.
 */
function linkHandoffApprovals(
  items: AssistantConversationItem[],
  approvals: readonly AssistantApproval[],
): void {
  for (const approval of approvals) {
    if (!isTool(approval.tool, 'verity_session_handoff')) continue;
    const title =
      typeof approval.input === 'object' && approval.input !== null
        ? (approval.input as { title?: unknown }).title
        : undefined;
    if (typeof title !== 'string') continue;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (
        item?.kind !== 'assignment' ||
        item.state !== 'pending' ||
        item.approvalId !== undefined ||
        item.title.trim() !== title.trim()
      )
        continue;
      item.approvalId = approval.id;
      break;
    }
  }
}

/** The serialized size of an approval's input, or undefined when there is none to carry. */
function inputBytes(input: unknown): number | undefined {
  if (input === undefined) return undefined;
  try {
    const serialized = JSON.stringify(input);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether a handoff's error result is the denial a device sends from the card. */
function declinedOnCard(output: unknown): boolean {
  try {
    return ((typeof output === 'string' ? output : JSON.stringify(output)) ?? '').includes(
      ASSISTANT_HANDOFF_DECLINED,
    );
  } catch {
    return false;
  }
}

/** The target session a handoff's result names. The output is the tool's JSON answer,
 *  possibly wrapped as MCP text content, so the id is read from its serialized form. */
function handoffTarget(output: unknown): string | undefined {
  const text =
    typeof output === 'string'
      ? output
      : Array.isArray(output)
        ? output
            .map((part: unknown) =>
              typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
            )
            .join('')
        : undefined;
  let parsed: unknown = output;
  if (text !== undefined) {
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  const sessionId =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { sessionId?: unknown }).sessionId
      : undefined;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function toolItem(
  name: string,
  input: unknown,
  id: string,
  at: number,
): AssistantConversationItem | undefined {
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (isTool(name, ASSISTANT_TOOL) && record.action === 'add_task') {
    return {
      kind: 'task',
      id,
      at,
      title: typeof record.title === 'string' ? record.title : '',
      projectId: typeof record.projectId === 'string' ? record.projectId : '',
      state: 'pending',
    };
  }
  if (
    isTool(name, ASSISTANT_TOOL) &&
    (record.action === 'prepare_meeting' || record.action === 'join_meeting')
  ) {
    return {
      kind: 'meeting',
      id,
      at,
      action: record.action === 'join_meeting' ? 'join' : 'prepare',
      // Only online meetings can be joined; the schema refuses anything else.
      mode:
        record.action === 'prepare_meeting' && record.mode === 'in_person' ? 'in_person' : 'online',
      eventKey: typeof record.eventKey === 'string' ? record.eventKey : null,
      title: typeof record.title === 'string' ? record.title : null,
      state: 'pending',
    };
  }
  if (isTool(name, 'verity_session_handoff')) {
    const target = record.target as Record<string, unknown> | undefined;
    const fresh = target?.newSession as Record<string, unknown> | undefined;
    const project = target?.project ?? fresh?.project;
    return {
      kind: 'assignment',
      id,
      at,
      title: typeof record.title === 'string' ? record.title : '',
      project: typeof project === 'string' ? project : null,
      state: 'pending',
    };
  }
  return undefined;
}
