import type { SessionHistoryPage } from '@verity/mobile';

type SessionEvent = SessionHistoryPage['events'][number];

export interface MeetingAnswerCard {
  id: string;
  request: string;
  kind: 'research' | 'request';
  status: 'working' | 'ready' | 'failed';
  answer: string;
  requestId?: string;
}

export function meetingRequestFromPrompt(
  prompt: string,
  meetingId: string,
): Pick<MeetingAnswerCard, 'request' | 'kind' | 'requestId'> | null {
  const separator = prompt.indexOf('\n\n');
  if (separator < 0) return null;
  const header = prompt.slice(0, separator);
  const context = prompt.indexOf('\n\nRecent meeting transcript:', separator + 2);
  const request = prompt.slice(separator + 2, context < 0 ? undefined : context).trim();
  if (!request) return null;
  const requestId = /(?:^|\n\n)Meeting request reference: ([a-zA-Z0-9-]+)/u.exec(prompt)?.[1];
  if (header === `Research this point raised during live meeting ${meetingId}:`)
    return { request, kind: 'research', ...(requestId ? { requestId } : {}) };
  if (header === `During live meeting ${meetingId}, please respond to this request:`)
    return { request, kind: 'request', ...(requestId ? { requestId } : {}) };
  return null;
}

export function meetingAnswerCards(events: SessionEvent[], meetingId: string): MeetingAnswerCard[] {
  const cards: MeetingAnswerCard[] = [];
  let current: MeetingAnswerCard | null = null;
  for (const { seq, event } of events) {
    if (event.t === 'prompt' && !event.steered) {
      const request = meetingRequestFromPrompt(event.text, meetingId);
      current = request ? { id: String(seq), ...request, status: 'working', answer: '' } : null;
      if (current) cards.push(current);
    } else if (event.t === 'text' && !event.parentToolId && current) {
      current.answer += event.delta;
      if (current.answer.length > 20_000) current.answer = current.answer.slice(-20_000);
    } else if (event.t === 'tool_call' && !event.parentToolId && current) {
      // Progress before research tools is not the answer to show in the meeting card.
      current.answer = '';
    } else if (event.t === 'result' && current) {
      if (current.answer.trim()) current.status = 'ready';
    } else if (event.t === 'interrupted' && current) {
      current.status = current.answer.trim() ? 'ready' : 'failed';
      current = null;
    }
  }
  return cards;
}

export function unacknowledgedMeetingAnswers(
  local: MeetingAnswerCard[],
  history: MeetingAnswerCard[],
): MeetingAnswerCard[] {
  return local.filter(
    (pending) => !history.some((card) => pending.requestId && card.requestId === pending.requestId),
  );
}

export function sameMeetingRequest(a: MeetingAnswerCard, b: MeetingAnswerCard): boolean {
  if (a.requestId || b.requestId) return !!a.requestId && a.requestId === b.requestId;
  return a.request === b.request && a.kind === b.kind;
}

export function compactMeetingAnswer(answer: string): string {
  const text = answer
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 360 ? `${text.slice(0, 357).trimEnd()}…` : text;
}

export function meetingAnswerSource(answer: string): string | null {
  const url = /https?:\/\/[^\s)\]>]+/u.exec(answer)?.[0];
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return null;
  }
}
