import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { Dimensions, ScrollView, StyleSheet, Text } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { PINNED_PLAN_MAX_HEIGHT_SHARE, PinnedPlan } from './PinnedPlan';

const markdown =
  '# Separate gestures\n\n## Goal\nStop accidental drags.\n\n## Steps\n1. **Require long press** — Update SessionList.tsx.\n2. **Add haptics** — Signal drag start.';
const props = {
  markdown,
  revision: 1,
  sendNonce: 0,
  renderMarkdown: (text: string) => <Text>{text}</Text>,
  updated: false,
  deciding: false,
  disabled: false,
  error: undefined,
  onDismiss: jest.fn(),
  onImplement: jest.fn(),
  onAnswerDecision: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

it('shows planned mockup screens before the implementation is approved', () => {
  render(
    <PinnedPlan
      {...props}
      markdown={`${markdown}\n\n## Mockups\n- Home review entry\n- Full-screen review`}
    />,
  );
  expect(screen.getByText('Mockups')).toBeOnTheScreen();
  expect(screen.getByText('Home review entry')).toBeOnTheScreen();
  expect(screen.getByText('Full-screen review')).toBeOnTheScreen();
});

it('presents concise bullet titles with descriptions reserved for details', () => {
  render(<PinnedPlan {...props} />);
  expect(screen.getByText('Separate gestures')).toBeOnTheScreen();
  expect(screen.queryByText('Stop accidental drags.')).toBeNull();
  expect(screen.getByText('2 steps')).toBeOnTheScreen();
  expect(screen.getByText('Require long press')).toBeOnTheScreen();
  expect(screen.queryByText('Update SessionList.tsx.')).toBeNull();
  expect(screen.getAllByText('•')).toHaveLength(2);
  expect(screen.getAllByRole('button')).toHaveLength(4);
  fireEvent.press(screen.getByLabelText('Implement plan'));
  expect(props.onImplement).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText('Cancel plan'));
  expect(props.onDismiss).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Updated')).toBeNull();
});

it('replaces the proposal with its revision and blocks double decisions while saving', () => {
  const view = render(<PinnedPlan {...props} />);
  view.rerender(
    <PinnedPlan
      {...props}
      markdown={markdown.replace('Add haptics', 'Keep haptics')}
      updated
      deciding
      error="Please retry"
    />,
  );
  expect(screen.getByText('Updated')).toBeOnTheScreen();
  expect(screen.queryByText('Add haptics')).toBeNull();
  expect(screen.getByText('Keep haptics')).toBeOnTheScreen();
  expect(screen.getByText('Please retry')).toBeOnTheScreen();
  expect(screen.getByLabelText('Implement plan')).toBeDisabled();
  expect(screen.getByLabelText('Cancel plan')).toBeDisabled();
  fireEvent.press(screen.getByLabelText('Implement plan'));
  expect(props.onImplement).not.toHaveBeenCalled();
});

it('keeps the complete approved text visible when a proposal contains other sections', () => {
  const fullPlan = `${markdown}\n\n## Risks\nPreserve navigation and do not change the public API.`;
  render(<PinnedPlan {...props} markdown={fullPlan} />);
  fireEvent.press(screen.getByLabelText('Show full plan'));
  expect(screen.getByText(fullPlan)).toBeOnTheScreen();
  expect(screen.getAllByRole('button')).toHaveLength(4);
});

it('collapses on sending and reopens a new revision, including identical text', () => {
  const view = render(<PinnedPlan {...props} />);
  expect(screen.getByText('Separate gestures')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Show full plan'));
  view.rerender(<PinnedPlan {...props} sendNonce={1} />);
  expect(screen.queryByText(markdown)).toBeNull();
  // Collapsed, the card is one line: the title stays, the steps go.
  expect(screen.getByText('Separate gestures')).toBeOnTheScreen();
  expect(screen.queryByText('Require long press')).toBeNull();
  fireEvent.press(screen.getByLabelText('Expand plan'));
  expect(screen.getByText('Require long press')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Collapse plan'));
  view.rerender(<PinnedPlan {...props} sendNonce={1} revision={2} updated />);
  expect(screen.getByText('Separate gestures')).toBeOnTheScreen();
  expect(screen.getByLabelText('Show full plan')).toBeOnTheScreen();
  expect(props.onDismiss).not.toHaveBeenCalled();
});

const spec = [
  '# Pricing page',
  '## Goal',
  'Pick a plan in two taps.',
  '## Acceptance criteria',
  '- Toggle above the plans',
  '- Recommended plan highlighted',
  '## Open decisions',
  '1. **Show prices incl. VAT?** — Incl. VAT (recommended) | Excl. VAT',
  '## Steps',
  '1. **Page** — build it.',
].join('\n');

const decisions = spec.replace(
  '1. **Show prices incl. VAT?** — Incl. VAT (recommended) | Excl. VAT',
  [
    '1. **Show prices incl. VAT?** — Incl. VAT (recommended) | Excl. VAT',
    '2. **Billing period?** — Monthly | Yearly (recommended)',
    '3. **Free trial?** — 14 days | 30 days',
  ].join('\n'),
);

it('puts the open decision under the title and keeps the steps one tap away', () => {
  render(<PinnedPlan {...props} markdown={spec} />);
  expect(screen.getByText('1 step · 2 criteria · 1 decision')).toBeOnTheScreen();
  expect(screen.getByText('Show prices incl. VAT?')).toBeOnTheScreen();
  expect(screen.queryByText('Toggle above the plans')).toBeNull();
  fireEvent.press(screen.getByLabelText('Show plan steps'));
  expect(screen.getByText('Toggle above the plans')).toBeOnTheScreen();
  expect(screen.getByText('Show prices incl. VAT?')).toBeOnTheScreen();
});

it('preselects the recommendation and marks it with a tag, not a suffix', () => {
  render(<PinnedPlan {...props} markdown={spec} />);
  // A suffix would end up in the answer text the agent receives.
  expect(screen.queryByText('Incl. VAT · recommended')).toBeNull();
  expect(screen.getByText('Recommended')).toBeOnTheScreen();
  expect(screen.getByRole('radio', { name: 'Incl. VAT, recommended' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Excl. VAT' })).not.toBeChecked();
  fireEvent.press(screen.getByLabelText('Send answers'));
  expect(props.onAnswerDecision).toHaveBeenCalledWith('Show prices incl. VAT? → Incl. VAT');
});

it('shows one decision at a time and sends every answer in a single message', () => {
  render(<PinnedPlan {...props} markdown={decisions} />);
  expect(screen.getByText('Decision 1 of 3')).toBeOnTheScreen();
  expect(screen.queryByText('Billing period?')).toBeNull();
  fireEvent.press(screen.getByRole('radio', { name: 'Excl. VAT' }));
  // Choosing moves on to the next decision.
  expect(screen.getByText('Decision 2 of 3')).toBeOnTheScreen();
  expect(screen.queryByText('Show prices incl. VAT?')).toBeNull();
  fireEvent.press(screen.getByLabelText('Next decision'));
  expect(screen.getByText('Free trial?')).toBeOnTheScreen();
  // Without a recommendation nothing is chosen, so nothing can be sent yet.
  expect(screen.getByLabelText('Send answers')).toBeDisabled();
  expect(screen.getByText('Choose an answer for each decision to send them.')).toBeOnTheScreen();
  fireEvent.press(screen.getByRole('radio', { name: '30 days' }));
  expect(screen.getByText('Send answers (3)')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Previous decision'));
  expect(screen.getByRole('radio', { name: 'Yearly, recommended' })).toBeChecked();
  fireEvent.press(screen.getByLabelText('Send answers'));
  expect(props.onAnswerDecision).toHaveBeenCalledTimes(1);
  expect(props.onAnswerDecision).toHaveBeenCalledWith(
    'Show prices incl. VAT? → Excl. VAT\nBilling period? → Yearly\nFree trial? → 30 days',
  );
});

it('starts a new revision from its own recommendations, not the earlier selection', () => {
  const view = render(<PinnedPlan {...props} markdown={decisions} />);
  fireEvent.press(screen.getByRole('radio', { name: 'Excl. VAT' }));
  expect(screen.getByText('Decision 2 of 3')).toBeOnTheScreen();
  view.rerender(<PinnedPlan {...props} markdown={decisions} revision={2} updated />);
  expect(screen.getByText('Decision 1 of 3')).toBeOnTheScreen();
  expect(screen.getByRole('radio', { name: 'Incl. VAT, recommended' })).toBeChecked();
});

it('bounds its height and keeps the actions outside the scrolling content', () => {
  // An unbounded card pushed Implement and the composer off a phone screen.
  render(<PinnedPlan {...props} markdown={decisions} />);
  const { height } = Dimensions.get('window');
  const style = StyleSheet.flatten(screen.getByTestId('pinned-plan').props.style);
  expect(style.maxHeight).toBe(Math.round(height * PINNED_PLAN_MAX_HEIGHT_SHARE));
  expect(style.maxHeight).toBeLessThan(height);
  const scroll = within(screen.UNSAFE_getByType(ScrollView));
  expect(scroll.getByText('Show prices incl. VAT?')).toBeOnTheScreen();
  expect(scroll.queryByLabelText('Send answers')).toBeNull();
  expect(scroll.queryByLabelText('Cancel plan')).toBeNull();
  expect(screen.getByLabelText('Send answers')).toBeOnTheScreen();
});

it('measures its bound against the part of the window the keyboard leaves', () => {
  // A share of the full window still overflows once the keyboard covers half of it.
  render(<PinnedPlan {...props} markdown={decisions} keyboardHeight={300} />);
  const { height } = Dimensions.get('window');
  const style = StyleSheet.flatten(screen.getByTestId('pinned-plan').props.style);
  expect(style.maxHeight).toBe(Math.round((height - 300) * PINNED_PLAN_MAX_HEIGHT_SHARE));
  // With the keyboard up, the first tap on an answer must select it.
  expect(screen.UNSAFE_getByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled');
});

it('opens the collapsed card instead of sending answers out of sight', () => {
  const view = render(<PinnedPlan {...props} markdown={decisions} />);
  view.rerender(<PinnedPlan {...props} markdown={decisions} sendNonce={1} />);
  expect(screen.queryByText('Decision 1 of 3')).toBeNull();
  // A screen reader must not announce a send that does not happen.
  expect(screen.queryByLabelText('Send answers')).toBeNull();
  expect(screen.getByText('Show answers (2)')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Show answers'));
  expect(props.onAnswerDecision).not.toHaveBeenCalled();
  expect(screen.getByText('Decision 1 of 3')).toBeOnTheScreen();
});

it('tells which decisions still belong in the chat when others have options', () => {
  render(<PinnedPlan {...props} markdown={decisions.replace('— 14 days | 30 days', '')} />);
  expect(screen.getByText('One decision has no options: answer it in the chat.')).toBeOnTheScreen();
});

it('keeps Implement away while a decision is open, and only then', () => {
  // The server refuses such a plan; an Implement button would only produce an error.
  const view = render(<PinnedPlan {...props} markdown={spec} />);
  expect(screen.queryByLabelText('Implement plan')).toBeNull();

  view.rerender(
    <PinnedPlan {...props} markdown={spec.replace(/## Open decisions\n.*\n/, '')} revision={2} />,
  );
  expect(screen.queryByLabelText('Send answers')).toBeNull();
  fireEvent.press(screen.getByLabelText('Implement plan'));
  expect(props.onImplement).toHaveBeenCalledTimes(1);
});

it('leaves a decision without options to the chat', () => {
  render(
    <PinnedPlan {...props} markdown={spec.replace('— Incl. VAT (recommended) | Excl. VAT', '')} />,
  );
  expect(screen.getByText('Answer in the chat.')).toBeOnTheScreen();
  expect(screen.getByLabelText('Send answers')).toBeDisabled();
});

it('marks only answered decisions as done, not ones skipped with Next', () => {
  // The trial decision has no recommendation, so skipping it leaves it open.
  const skipFirst = decisions.replace(
    /1\. \*\*Show prices.*\n2\. (.*)\n3\. (.*)/,
    '1. **Free trial?** — 14 days | 30 days\n2. $1\n3. **Show prices incl. VAT?** — Incl. VAT (recommended) | Excl. VAT',
  );
  render(<PinnedPlan {...props} markdown={skipFirst} />);
  expect(screen.getByText('Free trial?')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Next decision'));
  fireEvent.press(screen.getByLabelText('Next decision'));
  expect(screen.getByText('Decision 3 of 3')).toBeOnTheScreen();
  const color = (at: number) =>
    StyleSheet.flatten(
      (screen.getByTestId('decision-progress').children[at] as ReactTestInstance).props.style,
    ).backgroundColor;
  const open = color(0);
  const answered = color(1);
  expect(answered).not.toBe(open);
});
