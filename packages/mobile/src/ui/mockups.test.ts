import { describe, expect, it } from 'vitest';
import { mockupReviewSchema, type MockupReview } from '../api.js';
import type { ToolCall } from '../happy/message.js';
import { mockupBarView, mockupProgress, mockupRoundView } from './mockups.js';

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
  verdicts: [string, MockupReview['screens'][number]['verdict']][],
  state: MockupReview['state'] = 'pending',
): MockupReview => ({
  state,
  revision,
  screens: verdicts.map(([name, verdict]) => ({
    name,
    attachment: hash('a'),
    mediaType: 'image/png',
    width: 1,
    height: 1,
    verdict,
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
        ['Spec', 'discarded'],
        ['Home', 'approved'],
      ]),
    );
    expect(view).toMatchObject({ revision: 2, current: true });
    expect(view?.screens.map((screen) => screen.verdict)).toEqual(['discarded', 'approved']);
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
          ['C', 'discarded'],
        ]),
      ),
    ).toEqual({
      title: 'Mockups waiting for you',
      subtitle: '1 approved · 1 discarded · 1 to review',
      action: 'review',
    });
  });

  it('stays once every screen is marked, even when all are approved', () => {
    // Marks never start the build: the bar must remain reachable until the user
    // tells the agent in the chat, or a changed mind has nowhere to go.
    expect(
      mockupBarView(
        review(1, [
          ['A', 'approved'],
          ['B', 'approved'],
        ]),
      ),
    ).toEqual({ title: 'Mockups reviewed', subtitle: '2 approved', action: 'review' });
  });

  it('disappears once the review ended and waits quietly while revising', () => {
    expect(mockupBarView(review(1, [['A', 'approved']], 'approved'))).toBeUndefined();
    expect(mockupBarView(review(1, [['A', 'discarded']], 'revising'))?.action).toBeUndefined();
    expect(mockupBarView(undefined)).toBeUndefined();
  });
});

it('counts only the marks that exist in the progress line', () => {
  expect(
    mockupProgress(
      review(1, [
        ['A', 'open'],
        ['B', 'open'],
      ]),
    ),
  ).toBe('2 to review');
  expect(
    mockupProgress(
      review(1, [
        ['A', 'discarded'],
        ['B', 'discarded'],
      ]),
    ),
  ).toBe('2 discarded');
});

it('reads a comment from an older server as discarded, never as approved', () => {
  const screen = { name: 'A', attachment: hash('a'), mediaType: 'image/png', width: 1, height: 1 };
  expect(
    mockupReviewSchema.parse({
      state: 'pending',
      revision: 1,
      screens: [{ ...screen, verdict: 'comment', comment: 'Larger' }],
    })?.screens[0],
  ).toEqual({ ...screen, verdict: 'discarded' });
});
