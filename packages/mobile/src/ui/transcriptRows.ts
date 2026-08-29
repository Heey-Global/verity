import type { Message, ToolCallMessage } from '../happy/message.js';

/**
 * Transcript row grouping (pure → unit-testable). The session chat list renders
 * a {@link Row} per item. Grouping is a pure view concern over the canonical
 * message list, kept out of the React screen so the rules are tested without
 * rendering. It does three things (Claude-app style):
 *  - collapse a RUN of consecutive `tool-call` messages into one group row;
 *  - nest a SUB-agent's whole subtree (events tagged with `parentToolId`) under
 *    its spawning Agent/Task card as a collapsible `delegated-agent` row, instead
 *    of flattening the sub-agent's tool churn into the main transcript (#98);
 *  - collapse a run of `TaskCreate`/`TaskUpdate` calls into one `todo-group`.
 */
export type Row =
  | { kind: 'message'; message: Message }
  | { kind: 'tool-group'; id: string; tools: ToolCallMessage[] }
  | { kind: 'todo-group'; id: string; tools: ToolCallMessage[] }
  | {
      kind: 'delegated-agent';
      id: string;
      parent: ToolCallMessage;
      childRows: Row[];
      /** Count of tool calls in the whole subtree — the collapsed summary. */
      toolCount: number;
    };

const TOOL_ID_PREFIX = 'tool-';

/** Todo tools that the UI consolidates into one live widget rather than N cards. */
function isTodoTool(name: string): boolean {
  return name === 'TaskCreate' || name === 'TaskUpdate';
}

/** The sub-agent attribution a message carries (only agent-text / tool-call can). */
function messageParentToolId(m: Message): string | undefined {
  return m.kind === 'agent-text' || m.kind === 'tool-call' ? m.parentToolId : undefined;
}

/** The raw tool id behind a tool message's `tool-<id>` id — the value a child's
 * `parentToolId` references. Must stay in sync with the `tool-` prefix the reducer
 * prepends in `openTool` (reducer.ts). */
function rawToolId(m: ToolCallMessage): string {
  return m.id.startsWith(TOOL_ID_PREFIX) ? m.id.slice(TOOL_ID_PREFIX.length) : m.id;
}

/** Count tool-call messages in a subtree (including nested sub-agents). `visited`
 * guards against a `parentToolId` cycle in untrusted wire input. */
function countTools(
  messages: readonly Message[],
  childrenByParent: Map<string, Message[]>,
  visited: ReadonlySet<string>,
): number {
  let n = 0;
  for (const m of messages) {
    if (m.kind === 'tool-call') {
      n += 1;
      const rawId = rawToolId(m);
      const kids = childrenByParent.get(rawId);
      if (kids && !visited.has(rawId)) {
        n += countTools(kids, childrenByParent, new Set(visited).add(rawId));
      }
    }
  }
  return n;
}

/** Build the rows for one level (top-level, or a delegation's children). `visited`
 * is the set of parent ids already being expanded on this path — re-encountering
 * one (a cycle) renders it as a plain tool instead of recursing forever. */
function buildRows(
  messages: readonly Message[],
  childrenByParent: Map<string, Message[]>,
  visited: ReadonlySet<string>,
): Row[] {
  const rows: Row[] = [];
  let toolRun: ToolCallMessage[] = [];
  let todoRun: ToolCallMessage[] = [];
  // A group's key is derived from its LAST member, not its first. History scroll-up
  // prepends an OLDER page, which extends a boundary run at its HEAD — keying by the
  // first tool would change the key of an already-rendered group (its new head is an
  // older tool), and FlashList's maintainVisibleContentPosition loses that anchor →
  // the transcript jumps. The last member is stable across a prepend, so the anchored
  // row keeps its key and the viewport stays pinned. (It's also the tool the collapsed
  // ToolGroup/TodoGroup shows as its headline, so key and visible identity match.) The
  // trade: a live run growing at the TAIL re-keys per streamed tool (a cheap remount of
  // a small collapsed row, while pinned at the bottom) — acceptable vs. the scroll jump.
  const flushTools = (): void => {
    if (toolRun.length > 0) {
      rows.push({
        kind: 'tool-group',
        id: `tools:${toolRun[toolRun.length - 1]?.id ?? ''}`,
        tools: toolRun,
      });
      toolRun = [];
    }
  };
  const flushTodos = (): void => {
    if (todoRun.length > 0) {
      rows.push({
        kind: 'todo-group',
        id: `todos:${todoRun[todoRun.length - 1]?.id ?? ''}`,
        tools: todoRun,
      });
      todoRun = [];
    }
  };
  const flushAll = (): void => {
    flushTools();
    flushTodos();
  };

  for (const m of messages) {
    if (m.kind !== 'tool-call') {
      flushAll();
      rows.push({ kind: 'message', message: m });
      continue;
    }
    const rawId = rawToolId(m);
    const kids = childrenByParent.get(rawId);
    if (kids && kids.length > 0 && !visited.has(rawId)) {
      // A delegation: collapse its whole subtree under one card.
      flushAll();
      const nextVisited = new Set(visited).add(rawId);
      rows.push({
        kind: 'delegated-agent',
        id: `agent:${m.id}`,
        parent: m,
        childRows: buildRows(kids, childrenByParent, nextVisited),
        toolCount: countTools(kids, childrenByParent, nextVisited),
      });
    } else if (isTodoTool(m.tool.name)) {
      flushTools();
      todoRun.push(m);
    } else {
      flushTodos();
      toolRun.push(m);
    }
  }
  flushAll();
  return rows;
}

/** Group a flat message list into renderable rows (see {@link Row}). Order is
 * preserved; sub-agent children are lifted out of the top level and nested under
 * their dispatch. A child whose parent isn't present (it hasn't streamed in yet,
 * or was dropped) falls back to the top level so it is never lost. */
export function groupRows(messages: readonly Message[]): Row[] {
  // The set of tool ids that actually exist as messages — a parent must be real
  // for its children to nest (else the child is an orphan, kept at top level).
  const toolIds = new Set<string>();
  for (const m of messages) {
    if (m.kind === 'tool-call') toolIds.add(rawToolId(m));
  }
  const childrenByParent = new Map<string, Message[]>();
  for (const m of messages) {
    const parent = messageParentToolId(m);
    if (parent !== undefined && toolIds.has(parent)) {
      const arr = childrenByParent.get(parent) ?? [];
      arr.push(m);
      childrenByParent.set(parent, arr);
    }
  }
  const topLevel = messages.filter((m) => {
    const parent = messageParentToolId(m);
    return parent === undefined || !toolIds.has(parent);
  });
  return buildRows(topLevel, childrenByParent, new Set());
}

/** The stable React key for a row: the group/delegation id, else the message id. */
export function rowKey(row: Row): string {
  switch (row.kind) {
    case 'tool-group':
    case 'todo-group':
    case 'delegated-agent':
      return row.id;
    case 'message':
      return row.message.id;
  }
}

/**
 * Height class for a text-bearing row, used to keep FlashList recycling pools
 * shape-compatible. Classes get COARSER as they grow but never collapse into one
 * open bucket the way the old scheme did: its top class started at 2.4k with no ceiling,
 * so a many-screen agent turn and a ~one-screen one shared a pool and recycling the tall
 * cell into the short row left the tall native height behind — the large blank block this
 * guards against. The classes here keep splitting up to `huge`, so the residual height a
 * recycled cell can carry stays a screen or so instead of many. Codex especially produces
 * both very long turns and one-line progress notes, which is where this matters most.
 */
function lengthBucket(length: number): string {
  if (length < 320) return 'short';
  if (length < 960) return 'medium';
  if (length < 2400) return 'long';
  if (length < 6000) return 'xlong';
  if (length < 15000) return 'xxlong';
  return 'huge';
}

/**
 * FlashList recycling pool for a transcript row. Prose varies from a one-line progress
 * note to many screens of output; putting all of it in one pool lets an iOS recycled
 * cell briefly retain the height of a much longer message, which appears as a large
 * blank block between replies. Every text-bearing kind (agent prose, agent thinking,
 * and the operator's own prompts) renders at full height, so each is bucketed by text
 * length; non-text rows keep a stable per-kind pool. Collapsible tool/delegation rows
 * are additionally remounted per item at the render site so a previously-expanded cell
 * cannot carry its tall height into a collapsed one.
 */
export function rowRecycleType(row: Row): string {
  if (row.kind !== 'message') return row.kind;
  const message = row.message;
  if (message.kind === 'agent-text') {
    const family = message.isThinking ? 'thinking' : 'agent-text';
    return `msg:${family}:${lengthBucket(message.text.length)}`;
  }
  if (message.kind === 'user-text') return `msg:user-text:${lengthBucket(message.text.length)}`;
  return `msg:${message.kind}`;
}
