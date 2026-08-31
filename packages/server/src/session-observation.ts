import type { SequencedEvent } from '@verity/store';

const MAX_MESSAGE_CHARS = 4_000;

function redactSensitiveText(value: string): string {
  return (
    value
      .replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/giu,
        '[REDACTED PRIVATE KEY]',
      )
      .replace(
        /\b(?:sk-ant-|sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-|dp\.(?:st|sa|ct|scim|audit)\.)[A-Za-z0-9._-]{8,}\b/giu,
        '[REDACTED CREDENTIAL]',
      )
      .replace(/\bAKIA[A-Z0-9]{16}\b/gu, '[REDACTED AWS ACCESS KEY]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED JWT]')
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
      .replace(
        /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/giu,
        '$1: [REDACTED]',
      )
      .replace(
        /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*=[^\r\n]*/gu,
        '$1=[REDACTED]',
      )
      .replace(
        /\b(password|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret)\s*(?::|=|\bis\b|\bwas\b)[^\r\n]*/giu,
        '$1: [REDACTED]',
      )
      // Unknown providers often issue opaque high-entropy values without a stable prefix.
      // Losing an occasional digest from this optional read is safer than disclosing one.
      .replace(
        /\b(?=[A-Za-z0-9_./+=-]{32,}\b)(?=[^\r\n]*[A-Za-z])(?=[^\r\n]*\d)[A-Za-z0-9_./+=-]+\b/gu,
        '[REDACTED OPAQUE TOKEN]',
      )
  );
}

export function redactSessionObservationText(value: string): string {
  if (value.length > MAX_MESSAGE_CHARS * 4) {
    return '[message omitted: exceeds safe observation bound]';
  }
  return redactSensitiveText(value).slice(0, MAX_MESSAGE_CHARS);
}

/** Keep progress failures useful without returning the error event's free-form message. */
export function safeSessionProgressErrorKind(value: string): string {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value) ? value : 'unknown';
}

function redactSessionObservationTail(value: string): string {
  const redacted = redactSensitiveText(value);
  if (redacted.length <= MAX_MESSAGE_CHARS) return redacted;
  const marker = '[…earlier text truncated…]\n';
  return marker + redacted.slice(-(MAX_MESSAGE_CHARS - marker.length));
}

function boundedRawTail(value: string): { text: string; truncated: boolean } {
  const limit = MAX_MESSAGE_CHARS * 4;
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(-limit), truncated: true };
}

export interface SafeRecentMessage {
  role: 'user' | 'assistant' | 'system-error';
  text: string;
  timestamp: number;
}

type PublishedProgressEvent = SequencedEvent & {
  event: Extract<SequencedEvent['event'], { t: 'session_progress' }>;
};

/** A published claim belongs only to the standalone turn that contains it. */
export function currentPublishedProgress(
  events: readonly SequencedEvent[],
): PublishedProgressEvent | undefined {
  const latestPublished = events.findLast(
    (item): item is PublishedProgressEvent => item.event.t === 'session_progress',
  );
  const latestPrompt = events.findLast(
    ({ event }) => event.t === 'prompt' && event.steered !== true,
  );
  return latestPublished !== undefined &&
    (latestPrompt === undefined || latestPublished.seq > latestPrompt.seq)
    ? latestPublished
    : undefined;
}

export function olderEventsMayMatchWindow(
  pageHasMore: boolean,
  oldestTimestamp: number | undefined,
  sinceMs: number | undefined,
): boolean {
  return (
    pageHasMore &&
    (sinceMs === undefined || (oldestTimestamp !== undefined && oldestTimestamp >= sinceMs))
  );
}

export function safeRecentMessages(
  events: readonly SequencedEvent[],
  count: number,
  sinceMs?: number,
  boundaries: { olderEventsExist?: boolean; newerEventsExist?: boolean } = {},
): { messages: SafeRecentMessage[]; hasMore: boolean; nextBeforeSeq?: number } {
  const candidates: Array<SafeRecentMessage & { seq: number; truncated?: boolean }> = [];
  let currentAssistant: (SafeRecentMessage & { seq: number; truncated?: boolean }) | undefined;
  for (const item of events) {
    if (sinceMs !== undefined && item.ts < sinceMs) continue;
    const event = item.event;
    if (event.t === 'prompt') {
      currentAssistant = undefined;
      candidates.push({
        role: 'user',
        text: event.text,
        timestamp: item.ts,
        seq: item.seq,
      });
    } else if (event.t === 'text' && event.parentToolId === undefined) {
      if (currentAssistant !== undefined) {
        const bounded = boundedRawTail(currentAssistant.text + event.delta);
        currentAssistant.text = bounded.text;
        if (bounded.truncated) currentAssistant.truncated = true;
        currentAssistant.timestamp = item.ts;
      } else {
        const bounded = boundedRawTail(event.delta);
        currentAssistant = {
          role: 'assistant',
          text: bounded.text,
          timestamp: item.ts,
          seq: item.seq,
          ...(bounded.truncated ? { truncated: true } : {}),
        };
        candidates.push(currentAssistant);
      }
    } else if (event.t === 'error') {
      currentAssistant = undefined;
      candidates.push({
        role: 'system-error',
        text: event.message,
        timestamp: item.ts,
        seq: item.seq,
      });
    } else if (
      event.t === 'result' ||
      event.t === 'interrupted' ||
      (event.t === 'status' && ['completed', 'crashed'].includes(event.state))
    ) {
      currentAssistant = undefined;
    }
  }
  let nonEmpty = candidates.filter((message) => message.text.trim().length > 0);
  const firstAssistant = nonEmpty.find((message) => message.role === 'assistant');
  const timeBoundaryCutsHistory = sinceMs !== undefined && events.some((item) => item.ts < sinceMs);
  if (
    (boundaries.olderEventsExist === true || timeBoundaryCutsHistory) &&
    firstAssistant !== undefined &&
    !events.some(
      (item) =>
        item.seq < firstAssistant.seq &&
        (sinceMs === undefined || item.ts >= sinceMs) &&
        item.event.t === 'prompt' &&
        item.event.steered !== true,
    )
  ) {
    // The assistant response may have started on the older storage page. Returning only its tail
    // could split a credential across two separately approved reads and evade whole-value redaction.
    nonEmpty = nonEmpty.filter((message) => message !== firstAssistant);
  }
  const lastCandidate = nonEmpty.at(-1);
  const trailingAssistantIsComplete =
    lastCandidate?.role === 'assistant' &&
    events.some(
      (item) =>
        item.seq > lastCandidate.seq &&
        (item.event.t === 'result' ||
          item.event.t === 'interrupted' ||
          (item.event.t === 'status' && ['completed', 'crashed'].includes(item.event.state))),
    );
  if (
    boundaries.newerEventsExist === true &&
    lastCandidate?.role === 'assistant' &&
    !trailingAssistantIsComplete
  ) {
    // Its continuation lives on the newer storage page. Preserve the prompt/response shape while
    // exposing no partial logical message that could contain half of a credential.
    lastCandidate.text = '[assistant message omitted: crosses approved page boundary]';
    lastCandidate.truncated = false;
  }
  const selected = nonEmpty.slice(-count);
  return {
    messages: selected.map(({ role, text, timestamp, truncated }) => ({
      role,
      text:
        role === 'assistant' && truncated === true
          ? '[assistant message omitted: exceeds safe observation bound]'
          : role === 'assistant'
            ? redactSessionObservationTail(text)
            : redactSessionObservationText(text),
      timestamp,
    })),
    hasMore: nonEmpty.length > count,
    ...(nonEmpty.length > count && selected[0] !== undefined
      ? { nextBeforeSeq: selected[0].seq }
      : {}),
  };
}
