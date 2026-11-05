import type { MockupReview, MockupReviewScreen } from '../api.js';
import type { ToolCall } from '../happy/message.js';
import { unwrapToolResult } from './toolResult.js';

export type MockupVerdict = MockupReviewScreen['verdict'];

/** One presented screen as the chat and the review show it. `verdict` is absent
 *  for a round that a later presentation replaced: its verdicts no longer count. */
export interface MockupScreenView {
  name: string;
  attachment: string;
  mediaType: string;
  width: number;
  height: number;
  verdict?: MockupVerdict;
  comment?: string;
}

export interface MockupRoundView {
  revision: number;
  /** True while this round is the one waiting for review. */
  current: boolean;
  screens: MockupScreenView[];
}

const ATTACHMENT = /^[a-f0-9]{64}$/;

/**
 * The round a `verity_present_mockups` call showed, read from its confirmed
 * result. The result names the images, so an older round keeps showing what was
 * reviewed after the next one replaced the session's review. Verdicts come from
 * `current` while it is the same round.
 */
export function mockupRoundView(
  tool: ToolCall,
  current: MockupReview | undefined,
): MockupRoundView | undefined {
  if (tool.state !== 'completed' || !/(?:^|__)verity_present_mockups$/.test(tool.name))
    return undefined;
  const result = unwrapToolResult(tool.result);
  if (!result || result.presented !== true || !Number.isInteger(result.mockupRevision))
    return undefined;
  const revision = result.mockupRevision as number;
  const screens: MockupScreenView[] = [];
  for (const raw of Array.isArray(result.screens) ? (result.screens as unknown[]) : []) {
    if (!raw || typeof raw !== 'object') continue;
    const screen = raw as Record<string, unknown>;
    if (
      typeof screen.name !== 'string' ||
      typeof screen.attachment !== 'string' ||
      !ATTACHMENT.test(screen.attachment) ||
      typeof screen.width !== 'number' ||
      typeof screen.height !== 'number' ||
      screen.width <= 0 ||
      screen.height <= 0
    )
      continue;
    screens.push({
      name: screen.name,
      attachment: screen.attachment,
      mediaType: typeof screen.mediaType === 'string' ? screen.mediaType : 'image/png',
      width: screen.width,
      height: screen.height,
    });
  }
  if (screens.length === 0) return undefined;
  const live = current !== undefined && current.revision === revision;
  return {
    revision,
    current: live && current.state === 'pending',
    screens: live
      ? screens.map((screen) => {
          const state = current.screens.find((entry) => entry.name === screen.name);
          if (state === undefined) return screen;
          return state.comment !== undefined
            ? { ...screen, verdict: state.verdict, comment: state.comment }
            : { ...screen, verdict: state.verdict };
        })
      : screens,
  };
}

const ORDER: Record<MockupVerdict, number> = { open: 0, comment: 1, approved: 2 };

/** Screens still to decide first, then commented, then approved; stable within. */
export function reviewOrder<T extends { verdict?: MockupVerdict }>(screens: readonly T[]): T[] {
  return screens
    .map((screen, index) => ({ screen, index }))
    .sort(
      (a, b) =>
        ORDER[a.screen.verdict ?? 'open'] - ORDER[b.screen.verdict ?? 'open'] || a.index - b.index,
    )
    .map(({ screen }) => screen);
}

/** "1 of 3 approved · 1 comment" */
export function mockupProgress(review: Pick<MockupReview, 'screens'>): string {
  const approved = review.screens.filter((screen) => screen.verdict === 'approved').length;
  const comments = review.screens.filter((screen) => screen.verdict === 'comment').length;
  const parts = [`${String(approved)} of ${String(review.screens.length)} approved`];
  if (comments > 0) parts.push(`${String(comments)} ${comments === 1 ? 'comment' : 'comments'}`);
  return parts.join(' · ');
}

export interface MockupBarView {
  title: string;
  subtitle: string;
  /** The button: review the screens, or send the comments once nothing is open. */
  action: 'review' | 'send' | undefined;
}

/**
 * The slim bar above the composer while the build waits for the review. Absent
 * once the review is approved or before mockups were presented. When every
 * screen is decided but some carry comments, the round cannot complete by
 * approving, so the bar offers to send the comments instead.
 */
export function mockupBarView(review: MockupReview | undefined): MockupBarView | undefined {
  if (review === undefined || review.screens.length === 0) return undefined;
  if (review.state === 'revising')
    return {
      title: 'Agent is revising the mockups',
      subtitle: 'Your comments were sent',
      action: undefined,
    };
  if (review.state !== 'pending') return undefined;
  const open = review.screens.some((screen) => screen.verdict === 'open');
  const comments = review.screens.some((screen) => screen.verdict === 'comment');
  return {
    title: open ? 'Mockups waiting for you' : 'Send your comments',
    subtitle: mockupProgress(review),
    action: !open && comments ? 'send' : 'review',
  };
}
