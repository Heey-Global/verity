import type { AgentEvent } from '@verity/events';

/**
 * Renders a `ModeSwitchMessage` (kind `agent-event`) for the transcript. This is
 * the ONE place our `Message` contract diverges from upstream Happy: Happy's
 * `agent-event` carries its own `typesRaw.AgentEvent`, ours carries the canonical
 * `@verity/events` {@link AgentEvent}. So instead of reusing Happy's
 * `AgentEventBlock` verbatim, the RN component renders this descriptor — a small,
 * pure, unit-testable projection of our event into label/detail/tone.
 */

export type AgentEventTone = 'neutral' | 'warning' | 'danger';

export interface AgentEventDescriptor {
  /** Stable kind for the RN component to pick an icon / style. */
  kind: string;
  /** One-line human summary. */
  label: string;
  /** Optional secondary line. */
  detail?: string;
  tone: AgentEventTone;
  /** Optional recovery action rendered by the native transcript row. */
  action?: 'claude-login';
}

const CLAUDE_OAUTH_FAILURE = /failed to authenticate:.*oauth.*(?:expired|refresh)/i;

/**
 * Project a canonical event into a render descriptor. Only the lifecycle events
 * the reducer turns into `agent-event` messages (`compaction`/`interrupted`/
 * `merged`/`error`/`raw`) are expected; the `default` is a defensive fallback for
 * any other variant. (`rate_limit` is handled as session state + a banner, not a row.)
 */
export function agentEventDescriptor(event: AgentEvent): AgentEventDescriptor {
  switch (event.t) {
    case 'compaction':
      return { kind: 'compaction', label: 'Context compacted', tone: 'neutral' };
    case 'interrupted':
      return { kind: 'interrupted', label: 'Turn interrupted', tone: 'warning' };
    case 'merged':
      return { kind: 'merged', label: `Merged PR #${String(event.number)}`, tone: 'neutral' };
    case 'error':
      if (CLAUDE_OAUTH_FAILURE.test(event.message)) {
        return {
          kind: 'authentication-required',
          label: 'Claude login expired',
          detail: 'Sign in again to continue this session.',
          tone: 'danger',
          action: 'claude-login',
        };
      }
      return { kind: 'error', label: event.message, detail: event.kind, tone: 'danger' };
    case 'raw': {
      // Name the event kind, not just the backend. Without it every unmapped
      // stream type renders as "Unrecognized event / claude-code", so a type a
      // new CLI release starts emitting is indistinguishable from any other and
      // diagnosing it means digging the stored payload back out.
      const type = rawEventType(event.payload);
      return {
        kind: 'raw',
        label: 'Unrecognized event',
        detail: type === undefined ? event.backend : `${event.backend}: ${type}`,
        tone: 'neutral',
      };
    }
    default:
      return { kind: event.t, label: event.t, tone: 'neutral' };
  }
}

/** Backend payloads are `unknown`, so read the discriminant defensively and cap
 *  it: this string is rendered, and nothing upstream constrains its shape. */
function rawEventType(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== 'string') return undefined;
  const safe = type.replace(/[^\w.:-]/gu, '').slice(0, 64);
  return safe === '' ? undefined : safe;
}
