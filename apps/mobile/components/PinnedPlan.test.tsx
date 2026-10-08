import { fireEvent, render, screen } from '@testing-library/react-native';
import { PinnedPlan } from './PinnedPlan';

const markdown =
  '# Separate gestures\n\n## Goal\nStop accidental drags.\n\n## Steps\n1. **Require long press** — Update SessionList.tsx.\n2. **Add haptics** — Signal drag start.';
const props = {
  markdown,
  updated: false,
  deciding: false,
  disabled: false,
  error: undefined,
  onDismiss: jest.fn(),
  onImplement: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

it('presents the submitted plan as numbered steps with one decision per action', () => {
  render(<PinnedPlan {...props} />);
  expect(screen.getByText('Separate gestures')).toBeOnTheScreen();
  expect(screen.getByText('Stop accidental drags.')).toBeOnTheScreen();
  expect(screen.getByText('2 steps')).toBeOnTheScreen();
  expect(screen.getByText('Require long press')).toBeOnTheScreen();
  expect(screen.getByText('Update SessionList.tsx.')).toBeOnTheScreen();
  expect(screen.getByText('1')).toBeOnTheScreen();
  expect(screen.getByText('2')).toBeOnTheScreen();
  expect(screen.getAllByRole('button')).toHaveLength(2);
  fireEvent.press(screen.getByLabelText('Implement plan'));
  expect(props.onImplement).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText('Dismiss plan'));
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
  expect(screen.getByLabelText('Dismiss plan')).toBeDisabled();
  fireEvent.press(screen.getByLabelText('Implement plan'));
  expect(props.onImplement).not.toHaveBeenCalled();
});

it('keeps the complete approved text visible when a proposal contains other sections', () => {
  const fullPlan = `${markdown}\n\n## Risks\nPreserve navigation and do not change the public API.`;
  render(<PinnedPlan {...props} markdown={fullPlan} />);
  expect(screen.getByText(fullPlan)).toBeOnTheScreen();
  expect(screen.getAllByRole('button')).toHaveLength(2);
});
