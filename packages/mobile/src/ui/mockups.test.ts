import { describe, expect, it } from 'vitest';
import type { MockupReview } from '../api.js';
import type { ToolCall } from '../happy/message.js';
import { mockupBarView, mockupProgress, mockupRoundView, reviewOrder } from './mockups.js';

const hash = (char: string) => char.repeat(64);
const presented = {
  presented: true,
  mockupRevision: 2,
  screens: [
    { name: 'Spec', attachment: hash('a'), width: 393, height: 852, verdict: 'open' },
    { name: 'Home', attachment: hash('b'), width: 393, height: 852, verdict: 'open' },
  ],
};
const tool: ToolCall = {
  name: 'mcp__verity__verity_present_mockups',
  state: 'completed',
  input: {},
  createdAt: 0,
  startedAt: 0,
  completedAt: 1,
  description: null,
  result: { content: [{ type: 'text', text: JSON.stringify(presented) }] },
};
const review = (
  revision: number,
  verdicts: [string, MockupReview['screens'][number]['verdict'], string?][],
  state: MockupReview['state'] = 'pending',
): MockupReview => ({
  state,
  revision,
  screens: verdicts.map(([name, verdict, comment]) => ({
    name,
    attachment: hash('a'),
    mediaType: 'image/png',
    width: 1,
    height: 1,
    verdict,
    ...(comment !== undefined ? { comment } : {}),
  })),
});

describe('mockupRoundView', () => {
  it.each([
    'verity_present_mockups',
    'verity_mockups_present',
    'verity_verity_present_mockups',
    'mcp__verity__verity_mockups_present',
  ])('recognizes %s', (name) => {
    expect(mockupRoundView({ ...tool, name }, undefined)?.screens).toHaveLength(2);
  });
  it('shows the live verdicts on the round under review', () => {
    const view = mockupRoundView(
      tool,
      review(2, [
        ['Spec', 'comment', 'Move the decision up'],
        ['Home', 'approved'],
      ]),
    );
    expect(view).toMatchObject({ revision: 2, current: true });
    expect(view?.screens.map((screen) => [screen.verdict, screen.comment])).toEqual([
      ['comment', 'Move the decision up'],
      ['approved', undefined],
    ]);
  });

  it('keeps a replaced round readable without claiming its verdicts', () => {
    // Showing the new round's verdicts on old images would tell the reviewer a
    // screen they never saw was approved.
    const view = mockupRoundView(tool, review(3, [['Spec', 'approved']]));
    expect(view?.current).toBe(false);
    expect(view?.screens.every((screen) => screen.verdict === undefined)).toBe(true);
    expect(view?.screens.map((screen) => screen.attachment)).toEqual([hash('a'), hash('b')]);
  });

  it.each([
    ['another tool', { ...tool, name: 'mcp__verity__verity_present_plan' }],
    ['a running call', { ...tool, state: 'running' as const }],
    ['a failed call', { ...tool, result: { isError: true, content: tool.result } }],
    [
      'an attachment that is not a content hash',
      {
        ...tool,
        result: { ...presented, screens: [{ ...presented.screens[0], attachment: '../x' }] },
      },
    ],
  ])('ignores %s', (_label, call) => {
    // The images load from the server by attachment id; only a confirmed result
    // with content hashes may name what the chat fetches.
    expect(mockupRoundView(call, undefined)).toBeUndefined();
  });
});

describe('mockupBarView', () => {
  it('asks for a review while a screen is open', () => {
    expect(
      mockupBarView(
        review(1, [
          ['A', 'open'],
          ['B', 'approved'],
          ['C', 'comment', 'x'],
        ]),
      ),
    ).toEqual({
      title: 'Mockups waiting for you',
      subtitle: '1 of 3 approved · 1 comment',
      action: 'review',
    });
  });

  it('offers to send once every screen is decided and some carry comments', () => {
    // Approving cannot finish this round, so a Review button alone would leave
    // the build waiting with no visible way forward.
    expect(
      mockupBarView(
        review(1, [
          ['A', 'comment', 'x'],
          ['B', 'approved'],
        ]),
      )?.action,
    ).toBe('send');
  });

  it('disappears once approved and waits quietly while revising', () => {
    expect(mockupBarView(review(1, [['A', 'approved']], 'approved'))).toBeUndefined();
    expect(mockupBarView(review(1, [['A', 'comment', 'x']], 'revising'))?.action).toBeUndefined();
    expect(mockupBarView(undefined)).toBeUndefined();
  });
});

it('orders open screens first and keeps the presented order within a verdict', () => {
  expect(
    reviewOrder([
      { name: 'a', verdict: 'approved' as const },
      { name: 'b', verdict: 'open' as const },
      { name: 'c', verdict: 'comment' as const },
      { name: 'd', verdict: 'open' as const },
    ]).map((screen) => screen.name),
  ).toEqual(['b', 'd', 'c', 'a']);
});

it('counts comments in the progress line', () => {
  expect(
    mockupProgress(
      review(1, [
        ['A', 'comment', 'x'],
        ['B', 'comment', 'y'],
      ]),
    ),
  ).toBe('0 of 2 approved · 2 comments');
});
