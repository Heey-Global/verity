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
