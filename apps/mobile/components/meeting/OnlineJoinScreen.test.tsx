import { fireEvent, render, screen } from '@testing-library/react-native';
import { joinFailureText, OnlineJoinScreen } from './OnlineJoinScreen';

const handlers = () => ({
  onMinimize: jest.fn(),
  onCancel: jest.fn(),
  onRetry: jest.fn(),
  onClose: jest.fn(),
});

const show = (
  status: 'joining' | 'waiting' | 'failed',
  fields: { reason?: string | null; waitedMs?: number; cancelling?: boolean } = {},
) => {
  const on = handlers();
  render(
    <OnlineJoinScreen
      title="Product planning"
      status={{ status, reason: fields.reason ?? null }}
      platform="google_meet"
      waitedMs={fields.waitedMs ?? 5_000}
      topInset={0}
      bottomInset={0}
      cancelling={fields.cancelling ?? false}
      {...on}
    />,
  );
  return on;
};

// Many calls let the bot straight in; a "Let in" step would then promise a wait that never comes.
it('shows the admission step only for a reported waiting room', () => {
  show('joining');
  expect(screen.getByText('Joining the call')).toBeOnTheScreen();
  expect(screen.getByText('Google Meet')).toBeOnTheScreen();
  expect(screen.queryByText('Let in')).toBeNull();
  expect(screen.getByText('Live')).toBeOnTheScreen();
  screen.unmount();
  show('waiting');
  expect(screen.getByText('Waiting to be let in')).toBeOnTheScreen();
  expect(screen.getByText('Ask the host to admit Verity.')).toBeOnTheScreen();
  expect(screen.getByLabelText('Let in, in progress')).toBeOnTheScreen();
  expect(screen.getByLabelText('Joining, done')).toBeOnTheScreen();
});

// Google Meet and Teams do not report their lobby; a long join hints at it without claiming it.
it('suggests the lobby only after a long join', () => {
  show('joining', { waitedMs: 60_000 });
  expect(screen.getByText('The host may need to let Verity in.')).toBeOnTheScreen();
  expect(screen.queryByText('Waiting to be let in')).toBeNull();
});

it('names why joining failed and offers a retry', () => {
  const on = show('failed', { reason: 'login_required' });
  expect(screen.getByText('Could not join')).toBeOnTheScreen();
  expect(screen.getByText('The meeting requires sign-in.')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Cancel joining')).toBeNull();
  fireEvent.press(screen.getByText('Try again'));
  fireEvent.press(screen.getByText('Close'));
  expect(on.onRetry).toHaveBeenCalledTimes(1);
  expect(on.onClose).toHaveBeenCalledTimes(1);
});

it('cancels once', () => {
  const on = show('joining', { cancelling: true });
  fireEvent.press(screen.getByLabelText('Cancel joining'));
  expect(on.onCancel).not.toHaveBeenCalled();
  expect(screen.getByText('Cancelling…')).toBeOnTheScreen();
});

it.each([
  ['request_to_join_denied', 'The host declined Verity.'],
  ['waiting_room_timeout_exceeded', 'Nobody let Verity in.'],
  ['zoom_authorization_failed', 'Zoom did not let Verity join.'],
  ['something_new', 'The meeting service did not let Verity in.'],
  [null, 'The meeting service did not let Verity in.'],
])('explains %s', (reason, text) => {
  expect(joinFailureText(reason)).toBe(text);
});
