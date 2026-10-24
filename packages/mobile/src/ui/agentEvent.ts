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
  action?: 'claude-login' | 'tasks' | 'retry';
  /** Raw failure text for a collapsed "Details" section. Never the headline:
   *  it carries stderr tails, request ids and loader logs. */
  technical?: string;
}

const CLAUDE_OAUTH_FAILURE = /failed to authenticate:.*oauth.*(?:expired|refresh)/i;
const LIMIT_REACHED =
  /\b(?:rate limit|too many requests|quota exceeded|(?:limit|quota)\b.{0,40}\b(?:reached|exceeded)|you(?:['’]ve| have) (?:hit your (?:session|usage|weekly)|reached your [\w -]{1,40}) limit)\b/i;

/**
 * Project a canonical event into a render descriptor. Only the lifecycle events
 * the reducer turns into `agent-event` messages (`compaction`/`interrupted`/
 * `merged`/`error`/`raw`) are expected; the `default` is a defensive fallback for
 * any other variant. (`rate_limit` is handled as session state + a banner, not a row.)
 */
export function agentEventDescriptor(event: AgentEvent): AgentEventDescriptor {
  switch (event.t) {
    case 'tasks_updated': {
      const count = event.taskIds.length;
      // The agent's entries are its own working steps, kept apart from the
      // operator's task list in the panel; the wording keeps that apart too.
      const verb = {
        added: event.origin === 'agent' ? 'planned' : 'added',
        updated: 'updated',
        completed: event.origin === 'agent' ? 'finished' : 'completed',
        dropped: 'dropped',
        deleted: 'deleted',
      }[event.change];
      const noun = event.origin === 'agent' ? 'step' : 'task';
      return {
        kind: 'tasks',
        label: `${event.origin === 'agent' ? 'Agent' : 'You'} ${verb} ${String(count)} ${count === 1 ? noun : `${noun}s`}`,
        tone: 'neutral',
        action: 'tasks',
      };
    }
    case 'compaction':
      return { kind: 'compaction', label: 'Context compacted', tone: 'neutral' };
    case 'interrupted':
      return { kind: 'interrupted', label: 'Turn interrupted', tone: 'warning' };
    case 'merged':
      return { kind: 'merged', label: `Merged PR #${String(event.number)}`, tone: 'neutral' };
    case 'error':
      if (event.kind === 'model_capacity_retry') {
        return { kind: 'model-capacity', label: event.message, tone: 'neutral' };
      }
      if (event.kind === 'model_capacity') {
        return {
          kind: 'model-capacity',
          label: 'Model temporarily unavailable',
          detail: 'Try again later or select a different model.',
          tone: 'warning',
        };
      }
      if (CLAUDE_OAUTH_FAILURE.test(event.message)) {
        return {
          kind: 'authentication-required',
          label: 'Claude login expired',
          detail: 'Sign in again to continue this session.',
          tone: 'danger',
          action: 'claude-login',
        };
      }
      if (LIMIT_REACHED.test(event.message)) {
        return { kind: 'limit-reached', label: 'Usage limit reached', tone: 'neutral' };
      }
      return describeFailure(event.kind, event.message);
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

// Transport and provider outages: the agent never got an answer to act on, so
// the remedy is to wait and resend — not to inspect the session.
const PROVIDER_UNREACHABLE =
  /(?:\b(?:api error|status(?: code)?|http(?:\/[\d.]+)?)\W{0,3}5(?:0[02-4]|2\d)\b|\b(?:bad gateway|service unavailable|gateway time-?out|overloaded(?:_error)?|upstream (?:connect|error|request timeout)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error)\b)/iu;
// Kinds whose message is a process exit or a backend transport failure. Their
// text is a stderr tail, never a sentence written for the operator.
const PROCESS_FAILURE_KINDS = new Set(['crashed', 'acp', 'run_failed']);
const SUMMARY_LIMIT = 160;
const TECHNICAL_LIMIT = 2_000;

function describeFailure(kind: string, message: string): AgentEventDescriptor {
  const technical = technicalText(kind, message);
  if (PROVIDER_UNREACHABLE.test(message)) {
    return {
      kind: 'provider-unreachable',
      label: 'Model provider unreachable',
      detail: 'The request did not get through. Try again in a moment.',
      tone: 'warning',
      action: 'retry',
      technical,
    };
  }
  if (PROCESS_FAILURE_KINDS.has(kind)) {
    return {
      kind: 'agent-stopped',
      label: 'Agent stopped unexpectedly',
      detail: 'The turn ended with an error.',
      tone: 'danger',
      action: 'retry',
      technical,
    };
  }
  // A short adapter diagnostic ("bad line") already reads as a sentence; only a
  // multi-line or oversized message needs its full text tucked away.
  const summary = firstLine(message);
  return {
    kind: 'error',
    label: 'Agent error',
    detail: summary === '' ? kind : summary,
    tone: 'danger',
    ...(summary === message.trim() ? {} : { technical }),
  };
}

function firstLine(message: string): string {
  const line = stripControl(message).trim().split(/\r?\n/u)[0]?.trim() ?? '';
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line;
}

/** Keep the END of the text: a stderr tail puts the fatal line last. */
function technicalText(kind: string, message: string): string {
  const text = stripControl(message).trim();
  const tail = text.length > TECHNICAL_LIMIT ? `…${text.slice(-TECHNICAL_LIMIT)}` : text;
  return `${kind}\n${tail}`;
}

function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex -- terminal colour codes from CLI stderr
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '').replace(/[^\P{Cc}\n\t]/gu, '');
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
