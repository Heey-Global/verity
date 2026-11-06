import {
  ASSISTANT_TOOL,
  assistantMessageText,
  parseChoicesBlock,
  type AgentEvent,
  type AssistantConversation,
  type AssistantConversationItem,
  type AssistantQuestion,
} from '@verity/events';
import type { SequencedEvent } from '@verity/store';

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
        if (item?.kind === 'assignment') item.state = event.isError ? 'failed' : 'sent';
        if (item?.kind === 'meeting') item.state = event.isError ? 'failed' : 'ready';
        break;
      }
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
  const approvals = facts.approvals.map((approval) => ({
    id: approval.toolUseId,
    tool: approval.tool,
  }));
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
