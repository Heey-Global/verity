import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { PinnedPlan } from './PinnedPlan';

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
  expect(screen.queryByText('Separate gestures')).toBeNull();
  fireEvent.press(screen.getByLabelText('Expand plan'));
  expect(screen.getByText('Separate gestures')).toBeOnTheScreen();
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

it('shows criteria and answers an open decision through the chat', () => {
  render(<PinnedPlan {...props} markdown={spec} />);
  expect(screen.getByText('1 step · 2 criteria · 1 decision')).toBeOnTheScreen();
  expect(screen.getByText('Toggle above the plans')).toBeOnTheScreen();
  expect(screen.getByText('Show prices incl. VAT?')).toBeOnTheScreen();
  expect(screen.getByText('Incl. VAT · recommended')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Answer Show prices incl. VAT? with Excl. VAT'));
  expect(props.onAnswerDecision).toHaveBeenCalledWith('Show prices incl. VAT? → Excl. VAT');
});

it('keeps Implement locked while a decision is open, and only then', () => {
  // The server refuses such a plan; an enabled button would only produce an error.
  const view = render(<PinnedPlan {...props} markdown={spec} />);
  expect(screen.getByText('Answer the open decision to implement.')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Implement plan'));
  expect(props.onImplement).not.toHaveBeenCalled();

  view.rerender(
    <PinnedPlan {...props} markdown={spec.replace(/## Open decisions\n.*\n/, '')} revision={2} />,
  );
  expect(screen.queryByText('Answer the open decision to implement.')).toBeNull();
  fireEvent.press(screen.getByLabelText('Implement plan'));
  expect(props.onImplement).toHaveBeenCalledTimes(1);
});
