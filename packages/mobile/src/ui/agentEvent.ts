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
  /** `resend` repeats the operator's last message: the turn never reached the
   *  agent, so asking it to "try again" would lose the request itself. */
  action?: 'claude-login' | 'tasks' | 'retry' | 'resend';
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
      if (event.kind === 'memory_limit') {
        return {
          kind: 'memory-limit',
          label: 'Memory limit reached',
          detail: 'The memory guard stopped the agent. Retry with a smaller workload.',
          tone: 'danger',
          action: 'retry',
        };
      }
      if (
        PROCESS_FAILURE_KINDS.has(event.kind) &&
        /(?:SIGKILL|exit(?:ed with code)? 137)/u.test(event.message)
      ) {
        return {
          kind: 'agent-killed',
          label: 'Agent was killed',
          detail: 'Possible memory pressure. Retry with a smaller workload.',
          tone: 'danger',
          action: 'retry',
          technical: technicalText(event.kind, event.message),
        };
      }
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
      if (event.kind === SANDBOX_NOT_READY_KIND) return describeNotStarted(event.message);
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

/** Mirrors `SANDBOX_NOT_READY_ERROR_KIND` in `@verity/events`: the turn failed
 *  before the agent was launched, so nothing ran and nothing has to be undone. */
const SANDBOX_NOT_READY_KIND = 'sandbox_not_ready';

function describeNotStarted(message: string): AgentEventDescriptor {
  const text = stripControl(message).trim();
  const [first = '', ...rest] = text.split(/\r?\n/u);
  // Server-written explanations are sentences; the older lifecycle refusals are
  // terse fragments ("project Sandbox is cloning") and read better behind a
  // fixed explanation than as one.
  const sentence = /^[A-Z].*[.!?]$/u.test(first.trim());
  return {
    kind: 'agent-not-started',
    label: 'Agent couldn’t start',
    detail: sentence
      ? first.trim()
      : 'The project environment wasn’t ready. Your message wasn’t sent to the agent.',
    tone: 'warning',
    action: 'resend',
    ...(sentence && rest.length === 0
      ? {}
      : { technical: technicalText(SANDBOX_NOT_READY_KIND, text) }),
  };
}

// The Sandbox's egress connector answers a request it could not complete with a
// 502 whose body names what happened. The agent reports that as a bad gateway,
// which would otherwise read as the model provider being down while the
// provider was never reached. The three cases need different remedies, so they
// are told apart rather than all offered a retry.
const SANDBOX_EGRESS_UNAVAILABLE =
  /\b(?:Codex egress unavailable|Claude connector upstream unavailable)\b/u;
const SANDBOX_CODEX_UNCONFIGURED = /\bCodex egress is not configured for this Sandbox\b/u;
const SANDBOX_CONNECTOR_REJECTED = /\bVerity sandbox connector rejected the request\b/u;

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
  // Provisioned before the Codex gateway existed: retrying cannot add the leg.
  if (SANDBOX_CODEX_UNCONFIGURED.test(message)) {
    return {
      kind: 'codex-unconfigured',
      label: 'Codex isn’t set up in this environment',
      detail: 'The project environment has no Codex connection. Rebuilding it adds one.',
      tone: 'warning',
      technical,
    };
  }
  // Refused inside the Sandbox before any gateway was involved; the same
  // request would be refused again.
  if (SANDBOX_CONNECTOR_REJECTED.test(message)) {
    return {
      kind: 'egress-rejected',
      label: 'Agent request rejected',
      detail: 'The project environment refused the request before it reached the agent gateway.',
      tone: 'warning',
      technical,
    };
  }
  if (SANDBOX_EGRESS_UNAVAILABLE.test(message)) {
    return {
      kind: 'egress-unavailable',
      label: 'Agent connection unavailable',
      detail:
        'The project environment couldn’t reach the agent gateway. Try again; if it keeps failing, check the agent gateway.',
      tone: 'warning',
      action: 'retry',
      technical,
    };
  }
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
