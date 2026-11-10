import { isPresentMockupsTool } from '@verity/events';
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
  if (tool.state !== 'completed' || !isPresentMockupsTool(tool.name)) return undefined;
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
          return state === undefined ? screen : { ...screen, verdict: state.verdict };
        })
      : screens,
  };
}

/** "1 approved · 1 discarded"; "2 screens to review" while nothing is marked. */
export function mockupProgress(review: Pick<MockupReview, 'screens'>): string {
  const count = (verdict: MockupVerdict) =>
    review.screens.filter((screen) => screen.verdict === verdict).length;
  const approved = count('approved');
  const discarded = count('discarded');
  const open = count('open');
  const parts: string[] = [];
  if (approved > 0) parts.push(`${String(approved)} approved`);
  if (discarded > 0) parts.push(`${String(discarded)} discarded`);
  if (open > 0) parts.push(`${String(open)} to review`);
  return parts.join(' · ');
}

export interface MockupBarView {
  title: string;
  subtitle: string;
  /** Opens the full-screen review; absent while an earlier version revises. */
  action: 'review' | undefined;
}

/**
 * The slim bar above the composer while the review is open. Marks never end the
 * review: it stays until the user tells the agent in the chat to build, and the
 * agent ends it. Absent before mockups were presented and after the review ended.
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
  return {
    title: open ? 'Mockups waiting for you' : 'Mockups reviewed',
    subtitle: mockupProgress(review),
    action: 'review',
  };
}
