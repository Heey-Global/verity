import type { SessionHistoryPage } from '@verity/mobile';
import { meetingQuestionKey } from './liveMeetingInsights';

type SessionEvent = SessionHistoryPage['events'][number];

export interface MeetingAnswerCard {
  id: string;
  request: string;
  kind: 'research' | 'request';
  status: 'working' | 'ready' | 'failed';
  answer: string;
  requestId?: string;
  questionId?: string;
  questionTitle?: string;
  responseMs?: number;
  /** Another request was steered into this one's turn before it answered, so the reply
   * cannot be told apart; the card offers a separate retry instead of a guessed answer. */
  combined?: boolean;
}

export function meetingRequestFromPrompt(
  prompt: string,
  meetingId: string,
): Pick<
  MeetingAnswerCard,
  'request' | 'kind' | 'requestId' | 'questionId' | 'questionTitle'
> | null {
  const separator = prompt.indexOf('\n\n');
  if (separator < 0) return null;
  const header = prompt.slice(0, separator);
  const context = prompt.indexOf('\n\nRecent meeting transcript:', separator + 2);
  const request = prompt.slice(separator + 2, context < 0 ? undefined : context).trim();
  if (!request) return null;
  // Transcript content can mimic a reference; generated request metadata at the end takes precedence.
  const requestReference = [
    ...prompt.matchAll(/(?:^|\n\n)Meeting request reference: ([a-zA-Z0-9-]+)/gu),
  ].at(-1);
  const requestId = requestReference?.[1];
  const questionReference = [
    ...prompt.matchAll(/(?:^|\n\n)Meeting question reference: (question-[a-zA-Z0-9-]+)/gu),
  ].at(-1);
  const questionId =
    questionReference && (!requestReference || questionReference.index > requestReference.index)
      ? questionReference[1]
      : undefined;
  const titleReference = [
    ...prompt.matchAll(/(?:^|\n\n)Meeting question title: ("[^\n]*")(?=\n\n|$)/gu),
  ].at(-1);
  let questionTitle: string | undefined;
  if (
    questionId &&
    questionReference &&
    titleReference &&
    titleReference.index > questionReference.index
  ) {
    try {
      const decoded: unknown = JSON.parse(titleReference[1]!);
      if (typeof decoded === 'string') questionTitle = decoded;
    } catch {
      // Malformed optional metadata must not hide an otherwise valid answer.
    }
  }
  if (header === `Research this point raised during live meeting ${meetingId}:`)
    return {
      request,
      kind: 'research',
      ...(requestId ? { requestId } : {}),
      ...(questionId ? { questionId } : {}),
      ...(questionTitle ? { questionTitle } : {}),
    };
  if (header === `During live meeting ${meetingId}, please respond to this request:`)
    return {
      request,
      kind: 'request',
      ...(requestId ? { requestId } : {}),
      ...(questionId ? { questionId } : {}),
      ...(questionTitle ? { questionTitle } : {}),
    };
  return null;
}

export function meetingAnswerCards(events: SessionEvent[], meetingId: string): MeetingAnswerCard[] {
  const cards: MeetingAnswerCard[] = [];
  let current: MeetingAnswerCard | null = null;
  let startedAt: number | undefined;
  for (const { seq, event, ts } of events) {
    if (event.t === 'prompt') {
      const request = meetingRequestFromPrompt(event.text, meetingId);
      // A steered prompt joins the running turn: what follows answers the newer request.
      if (event.steered && !request) continue;
      startedAt = ts;
      if (event.steered && current && !current.combined) {
        Object.assign(current, { status: 'failed', combined: true, answer: '' });
      }
      current = request ? { id: String(seq), ...request, status: 'working', answer: '' } : null;
      if (current) {
        if (event.steered) Object.assign(current, { status: 'failed', combined: true });
        cards.push(current);
      }
    } else if (event.t === 'text' && !event.parentToolId && current && !current.combined) {
      current.answer += event.delta;
      if (current.answer.length > 20_000) current.answer = current.answer.slice(-20_000);
    } else if (event.t === 'tool_call' && !event.parentToolId && current && !current.combined) {
      // Progress before research tools is not the answer to show in the meeting card.
      current.answer = '';
    } else if (event.t === 'result' && current && !current.combined) {
      if (current.answer.trim()) {
        current.status = 'ready';
        if (startedAt !== undefined && ts !== undefined)
          current.responseMs = Math.max(0, ts - startedAt);
      }
    } else if (event.t === 'interrupted' && current && !current.combined) {
      current.status = current.answer.trim() ? 'ready' : 'failed';
      current = null;
    }
  }
  return cards;
}

/** Retain the latest request for each question before applying display or history limits. */
export function distinctMeetingAnswers(answers: MeetingAnswerCard[]): MeetingAnswerCard[] {
  return answers.reduce<MeetingAnswerCard[]>((cards, card) => {
    const index = cards.findIndex((item) =>
      item.questionId && card.questionId
        ? item.questionId === card.questionId
        : meetingQuestionKey(item.request) === meetingQuestionKey(card.request),
    );
    if (index >= 0) cards.splice(index, 1);
    cards.push(card);
    return cards;
  }, []);
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

// Answers are short bullet lists; the compact card keeps whole lines so a bullet never
// runs into the next one, and leaves inline Markdown for the card to render.
function answerLines(answer: string): string[] {
  return answer
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trimEnd())
    .filter((line) => line.trim());
}

/** True when the compact card leaves part of the answer out. */
export function meetingAnswerTruncated(answer: string): boolean {
  return compactMeetingAnswer(answer) !== answerLines(answer).join('\n');
}

export function compactMeetingAnswer(answer: string): string {
  const lines = answerLines(answer);
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length > 360) {
      if (kept.length) kept[kept.length - 1] += ' …';
      else kept.push(`${line.slice(0, 357).trimEnd()}…`);
      break;
    }
    kept.push(line);
    length += line.length;
  }
  return kept.join('\n');
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
