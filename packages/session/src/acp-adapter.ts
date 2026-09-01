import type { SessionUpdate, ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { parseAgentLoopProposal, parseChoicesBlock, type AgentEvent } from '@verity/events';
import {
  lifecycleSignalsFromMeta,
  StructuredLifecycleMapper,
  type StructuredLifecycleSignal,
} from './structured-lifecycle.js';

/** Each ACP agent carries its non-standard extras under its own `_meta` key.
 *  The Claude adapter uses `claudeCode`; codex-acp uses `codex`. */
const CLAUDE_ACP_META = 'claudeCode';
const CLAUDE_WEEKLY_RATE_LIMIT_TYPES = new Set([
  // `weekly` was emitted by the native Claude stream before the ACP migration.
  'weekly',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
]);

function claudeRateLimitScope(rateLimitType: unknown): string | undefined {
  if (rateLimitType === 'seven_day_opus') return 'opus';
  if (rateLimitType === 'seven_day_sonnet') return 'sonnet';
  if (rateLimitType === 'seven_day_overage_included') return 'overage_included';
  return undefined;
}

function namespaced(
  meta: { [key: string]: unknown } | null | undefined,
  namespace: string,
): Record<string, unknown> | undefined {
  const value = meta?.[namespace];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Translate the Claude Agent SDK quota extension carried by claude-agent-acp.
 * Partial and unknown windows are non-actionable bookkeeping, so they remain
 * silent rather than producing transcript noise or an invalid canonical event. */
function claudeRateLimit(update: SessionUpdate): AgentEvent[] {
  const info = record(update._meta?.['_claude/rateLimit']);
  if (info === undefined) return [];
  const status = info['status'];
  const resetsAt = info['resetsAt'];
  const rateLimitType = info['rateLimitType'];
  const utilization = info['utilization'];
  if (
    (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') ||
    typeof resetsAt !== 'number' ||
    !Number.isSafeInteger(resetsAt) ||
    resetsAt < 0
  ) {
    return [];
  }
  const window =
    rateLimitType === 'five_hour'
      ? 'five_hour'
      : typeof rateLimitType === 'string' && CLAUDE_WEEKLY_RATE_LIMIT_TYPES.has(rateLimitType)
        ? 'weekly'
        : undefined;
  if (window === undefined) return [];
  if (
    utilization !== undefined &&
    (typeof utilization !== 'number' ||
      !Number.isFinite(utilization) ||
      utilization < 0 ||
      utilization > 1)
  ) {
    return [];
  }
  return [
    {
      t: 'rate_limit',
      status,
      resetsAt,
      window,
      // The Claude Agent SDK rate_limit_event uses fractional utilization (0..1).
      // Normalize here; the separate OAuth usage endpoint is documented as 0..100.
      ...(utilization === undefined ? {} : { usedPercent: utilization * 100 }),
      ...(claudeRateLimitScope(rateLimitType) === undefined
        ? {}
        : { scope: claudeRateLimitScope(rateLimitType) }),
      providerLabel: 'Claude',
    },
  ];
}

export function parentToolId(
  meta: { [key: string]: unknown } | null | undefined,
  namespace: string = CLAUDE_ACP_META,
): string | undefined {
  const value = namespaced(meta, namespace)?.['parentToolUseId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** ACP's `kind` enum mapped onto the Verity tool names the transcript renders
 *  specially (`Bash` gets the command headline, the file tools the basename).
 *  Anything unmapped is left to the shared {@link toolName} fallback. */
const TOOL_KIND_NAMES: Readonly<Record<string, string>> = {
  execute: 'Bash',
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  fetch: 'Fetch',
  think: 'Think',
};

/**
 * The Verity tool name implied by a call's ACP `kind`, for the agents that
 * advertise no tool `name` at all.
 *
 * Both codex-acp and opencode-acp are in that class: they send `kind` plus a
 * `title` that is the rendering label — the command line for an execution, the
 * file path once a read resolves. Without this every Bash call would be titled
 * with its own command line and every read with a path, so the transcript could
 * not group them by tool. This is a profile's `resolveToolName`, consulted before
 * the shared resolver; `undefined` falls through to it unchanged.
 */
export function toolNameFromKind(tool: ToolCall | ToolCallUpdate): string | undefined {
  return typeof tool.kind === 'string' ? TOOL_KIND_NAMES[tool.kind] : undefined;
}

/** Resolve a tool call's Verity-facing name. ACP's own `title` is a rendering
 *  label, not an identity — for Bash it is the raw command line — so prefer the
 *  explicit name and the agent's `_meta.<namespace>.toolName` over it. */
export function toolName(
  tool: ToolCall | ToolCallUpdate,
  namespace: string = CLAUDE_ACP_META,
): string {
  const metaName = namespaced(tool._meta, namespace)?.['toolName'];
  return (
    (typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : undefined) ??
    (typeof metaName === 'string' && metaName.length > 0 ? metaName : undefined) ??
    ('title' in tool && typeof tool.title === 'string' && tool.title.length > 0
      ? tool.title
      : 'Tool')
  );
}

function toolOutput(tool: ToolCall | ToolCallUpdate, namespace: string): unknown {
  if (tool.rawOutput !== undefined) return tool.rawOutput;
  const response = namespaced(tool._meta, namespace)?.['toolResponse'];
  if (response !== undefined) return response;
  return tool.content ?? '';
}

function hasToolOutput(tool: ToolCall | ToolCallUpdate, namespace: string): boolean {
  if (tool.rawOutput !== undefined) return true;
  if (tool.content !== undefined && (!Array.isArray(tool.content) || tool.content.length > 0)) {
    return true;
  }
  return namespaced(tool._meta, namespace)?.['toolResponse'] !== undefined;
}

/** Translate lifecycle metadata already exposed by an ACP adapter. The Verity
 * extension is transport-neutral; the Codex branch consumes stable compaction
 * metadata shipped by codex-acp 1.1.14 without depending on its title. Codex's
 * subagent metadata describes individual activities, not agent lifetime, so it
 * remains ordinary tool activity until the adapter exposes a terminal signal. */
function acpLifecycleSignals(
  update: SessionUpdate,
  namespace: string,
): StructuredLifecycleSignal[] {
  const signals = lifecycleSignalsFromMeta(update._meta);
  if (namespace !== 'codex') return signals;

  if (
    (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
    update._meta?.['contextCompaction'] === true &&
    update.status === 'completed'
  ) {
    signals.push({ type: 'compaction', id: update.toolCallId });
  }

  return signals;
}

export interface AcpEventAdapterOptions {
  /** `_meta` key the agent carries its extras under. Defaults to Claude's. */
  readonly metaNamespace?: string | undefined;
  /** Transport-specific Verity tool name, consulted before the shared resolver.
   *  Return `undefined` to fall through to it — codex-acp, for instance, sets no
   *  `name` at all, so without this every Bash call would be titled with its own
   *  command line. */
  readonly resolveToolName?: ((tool: ToolCall | ToolCallUpdate) => string | undefined) | undefined;
}

/** Stateful ACP-v1 → Verity event mapper. Tool notifications are snapshots, so
 * each canonical start/call/result transition is emitted at most once. */
export class AcpEventAdapter {
  private readonly emitted = new Map<string, Set<'start' | 'call' | 'result'>>();
  private readonly snapshots = new Map<string, ToolCall | ToolCallUpdate>();
  private readonly pendingTerminal = new Set<string>();
  private readonly lifecycle = new StructuredLifecycleMapper();
  private readonly metaNamespace: string;
  private readonly resolveToolName:
    ((tool: ToolCall | ToolCallUpdate) => string | undefined) | undefined;

  constructor(options: AcpEventAdapterOptions = {}) {
    this.metaNamespace = options.metaNamespace ?? CLAUDE_ACP_META;
    this.resolveToolName = options.resolveToolName;
  }

  consume(update: SessionUpdate): AgentEvent[] {
    const lifecycle = this.lifecycle.consumeAll(acpLifecycleSignals(update, this.metaNamespace));
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return [
          ...lifecycle,
          ...(update.content.type === 'text' && update.content.text.length > 0
            ? [
                {
                  t: 'text' as const,
                  delta: update.content.text,
                  parentToolId: this.parent(update._meta),
                },
              ]
            : []),
        ];
      case 'agent_thought_chunk':
        return [
          ...lifecycle,
          ...(update.content.type === 'text' && update.content.text.length > 0
            ? [
                {
                  t: 'thinking' as const,
                  blockId: update.messageId ?? 'acp-thinking',
                  delta: update.content.text,
                  parentToolId: this.parent(update._meta),
                },
              ]
            : []),
        ];
      case 'tool_call':
      case 'tool_call_update':
        return [...this.tool(update), ...lifecycle];
      case 'plan':
      case 'plan_update':
      case 'plan_removed':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'config_option_update':
      case 'session_info_update':
        // These are recognized ACP bookkeeping notifications, not transcript
        // content. Persisting them as canonical `raw` events makes the mobile
        // reducer close the active text block and render an "Unrecognized
        // event / acp" row between ordinary message chunks. Capability,
        // configuration and usage state is handled by the ACP session/result
        // path; plans do not yet have a canonical Verity presentation.
        return lifecycle;
      case 'usage_update':
        return [
          ...lifecycle,
          ...(this.metaNamespace === CLAUDE_ACP_META ? claudeRateLimit(update) : []),
        ];
      case 'user_message_chunk':
        return lifecycle;
    }
  }

  private parent(meta: { [key: string]: unknown } | null | undefined): string | undefined {
    return parentToolId(meta, this.metaNamespace);
  }

  private name(tool: ToolCall | ToolCallUpdate): string {
    return this.resolveToolName?.(tool) ?? toolName(tool, this.metaNamespace);
  }

  private tool(tool: ToolCall | ToolCallUpdate): AgentEvent[] {
    const id = tool.toolCallId;
    const previous = this.snapshots.get(id);
    const snapshot = {
      ...previous,
      ...tool,
      _meta: tool._meta ?? previous?._meta,
    } as ToolCall | ToolCallUpdate;
    this.snapshots.set(id, snapshot);
    const seen = this.emitted.get(id) ?? new Set<'start' | 'call' | 'result'>();
    this.emitted.set(id, seen);
    const name = this.name(snapshot);
    const parent = this.parent(snapshot._meta);
    const events: AgentEvent[] = [];
    if (!seen.has('start')) {
      seen.add('start');
      events.push({ t: 'tool_call_start', id, name, parentToolId: parent });
    }
    if (!seen.has('call') && snapshot.rawInput !== undefined) {
      seen.add('call');
      events.push({ t: 'tool_call', id, name, input: snapshot.rawInput, parentToolId: parent });
    }
    if (snapshot.status === 'completed' || snapshot.status === 'failed') {
      this.pendingTerminal.add(id);
      if (hasToolOutput(snapshot, this.metaNamespace)) events.push(...this.finishTool(id));
    }
    return events;
  }

  /** The tool name already established for `toolCallId`, or `undefined` while the
   *  adapter has not seen that tool call yet. The ACP agent emits a tool call's
   *  `tool_call` notification before asking the client to approve it, so a
   *  permission request can recover the real tool name from here even though its
   *  own payload carries a usable name at best partially (Claude sets
   *  `_meta.claudeCode.toolName` only for subagent tools; codex-acp sets none). */
  knownToolName(toolCallId: string): string | undefined {
    const snapshot = this.snapshots.get(toolCallId);
    return snapshot === undefined ? undefined : this.name(snapshot);
  }

  /** Emit terminal snapshots that never received a separate payload update. */
  flush(): AgentEvent[] {
    return [...this.pendingTerminal].flatMap((id) => this.finishTool(id));
  }

  private finishTool(id: string): AgentEvent[] {
    const tool = this.snapshots.get(id);
    if (tool === undefined) return [];
    const seen = this.emitted.get(id) ?? new Set<'start' | 'call' | 'result'>();
    if (seen.has('result')) return [];
    const name = this.name(tool);
    const parent = this.parent(tool._meta);
    const events: AgentEvent[] = [];
    if (!seen.has('call')) {
      seen.add('call');
      events.push({ t: 'tool_call', id, name, input: tool.rawInput ?? {}, parentToolId: parent });
    }
    seen.add('result');
    this.pendingTerminal.delete(id);
    events.push({
      t: 'tool_result',
      id,
      output: toolOutput(tool, this.metaNamespace),
      isError: tool.status === 'failed',
      parentToolId: parent,
    });
    return events;
  }
}

/** Lift Verity's end-of-turn contracts after ACP streaming has completed. */
export function finalAcpTextEvents(text: string): AgentEvent[] {
  const parsedLoop = parseAgentLoopProposal(text);
  const { text: prose, choices } = parseChoicesBlock(parsedLoop.text);
  if (parsedLoop.proposal !== undefined) {
    return [
      ...(prose.length > 0 ? ([{ t: 'text', delta: prose }] satisfies AgentEvent[]) : []),
      { t: 'agent_loop_proposal', proposal: parsedLoop.proposal },
    ];
  }
  if (choices !== undefined) {
    return [
      ...(prose.length > 0 ? ([{ t: 'text', delta: prose }] satisfies AgentEvent[]) : []),
      { t: 'choices', ...choices },
    ];
  }
  return text.length > 0 ? [{ t: 'text', delta: text }] : [];
}

/** Streams ordinary prose immediately while retaining only a suffix that may
 * become a Verity machine-contract fence. Once a fence starts, buffer it until
 * turn end so its JSON never flashes into the chat. */
export class AcpTextStream {
  private static readonly fences = ['```verity:choices', '```verity:agent-loop'] as const;
  private static readonly maxContractLength = 64 * 1024;
  private pending = '';
  private bufferingContract = false;

  push(delta: string): AgentEvent[] {
    this.pending += delta;
    if (this.bufferingContract) {
      if (this.pending.length > AcpTextStream.maxContractLength) {
        const text = this.pending;
        this.pending = '';
        this.bufferingContract = false;
        return [{ t: 'text', delta: text }];
      }
      return [];
    }
    const opener = AcpTextStream.fences.reduce((earliest, fence) => {
      const index = this.pending.indexOf(fence);
      return index >= 0 && (earliest < 0 || index < earliest) ? index : earliest;
    }, -1);
    if (opener >= 0) {
      const before = this.pending.slice(0, opener);
      const prose = before.trimEnd();
      this.pending = before.slice(prose.length) + this.pending.slice(opener);
      this.bufferingContract = true;
      return prose.length > 0 ? [{ t: 'text', delta: prose }] : [];
    }
    const prefix = this.possibleFencePrefix();
    let streamLength = this.pending.length - prefix;
    while (streamLength > 0 && /\s/u.test(this.pending[streamLength - 1]!)) streamLength--;
    if (streamLength === 0) return [];
    const text = this.pending.slice(0, streamLength);
    this.pending = this.pending.slice(streamLength);
    return [{ t: 'text', delta: text }];
  }

  flush(): AgentEvent[] {
    const text = this.pending;
    this.pending = '';
    this.bufferingContract = false;
    return finalAcpTextEvents(text);
  }

  private possibleFencePrefix(): number {
    const maxFence = Math.max(...AcpTextStream.fences.map((fence) => fence.length));
    const limit = Math.min(this.pending.length, maxFence - 1);
    for (let length = limit; length > 0; length--) {
      const suffix = this.pending.slice(-length);
      if (AcpTextStream.fences.some((fence) => fence.startsWith(suffix))) return length;
    }
    return 0;
  }
}
