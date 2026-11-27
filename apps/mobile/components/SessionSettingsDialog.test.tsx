import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { VerityApiError, type VerityClient } from '@verity/mobile';
import { Modal, ScrollView, View } from 'react-native';
import { SessionSettingsDialog } from './SessionSettingsDialog';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => `operation-${Math.random()}`) }));
jest.mock('./Icon', () => ({ Icon: () => null }));
jest.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: jest.requireActual('../theme/tokens').darkTheme }),
}));

// The preset mocks host views with no-op native measurement, which would keep
// the floating project list forever unmeasured.
let layout: { select: [number, number, number, number]; cardHeight: number } | undefined;
beforeEach(() => {
  layout = { select: [20, 200, 300, 48], cardHeight: 600 };
  jest.spyOn(View.prototype, 'measureLayout').mockImplementation((_relative, onSuccess) => {
    if (layout) onSuccess(...layout.select);
  });
  jest.spyOn(View.prototype, 'measure').mockImplementation((onSuccess) => {
    if (layout) onSuccess(0, 0, 340, layout.cardHeight, 0, 0);
  });
});

const result = {
  projectId: 'b',
  worktree: '/b/new',
  branch: 'new',
  contextMode: 'history-handoff',
  transferred: [],
  alreadyPresent: [],
  skipped: ['private'],
  retainedWorktree: '/a/old',
  retainedBranch: 'old',
};
function setup(moveSession: jest.Mock, sessionId = 's') {
  const props = {
    sessionId,
    sessionName: 'Product images',
    displayName: 'Product images',
    projectId: 'a',
    projectName: 'Source project',
    canMove: true,
    projects: [
      { id: 'b', name: 'Target project' },
      { id: 'c', name: 'Other project' },
    ],
    client: {
      moveSession,
      renameSession: jest.fn().mockResolvedValue({}),
    } as unknown as VerityClient,
    onClose: jest.fn(),
    onChanged: jest.fn(),
    onDelete: jest.fn(),
  };
  const view = render(<SessionSettingsDialog {...props} />);
  return { ...view, props };
}
function selectTarget() {
  fireEvent.press(screen.getByRole('button', { name: 'Project' }));
  fireEvent.press(screen.getByRole('button', { name: 'Target project' }));
}
function move() {
  fireEvent.press(screen.getByRole('button', { name: /Save and move|Retry move/ }));
}

it('closes on Android back and offers no manual session linking', () => {
  const { props } = setup(jest.fn());
  // Links arise from coordination only; a leftover section would invite edits the server refuses.
  expect(screen.queryByText('Linked sessions')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Link a session' })).toBeNull();
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(props.onClose).toHaveBeenCalled();
});

it('leaves touches on the body to its scroll view', () => {
  setup(jest.fn());
  // A responder anywhere above the scroll view wins every drag that starts on
  // text, so the dialog cannot scroll to options below the fold on a tablet.
  let node = screen.UNSAFE_getByType(ScrollView).parent;
  while (node) {
    expect(node.props.onStartShouldSetResponder).toBeUndefined();
    node = node.parent;
  }
});

it('contains the dialog on tablets and keeps project options collapsed until requested', () => {
  setup(jest.fn());
  // Without a width cap the modal covers the entire split-view screen.
  expect(screen.getByTestId('session-settings-card')).toHaveStyle({ maxWidth: 440, width: '100%' });
  expect(screen.queryByText('Other project')).toBeNull();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  selectTarget();
  expect(screen.queryByText('Other project')).toBeNull();
  expect(screen.getByRole('button', { name: 'Project' })).toHaveAccessibilityValue({
    text: 'Target project',
  });
  expect(screen.getByRole('button', { name: /Save and move|Retry move/ })).toBeEnabled();
});
it('floats project options over the dialog instead of growing its content', () => {
  setup(jest.fn());
  const body = screen.UNSAFE_getByType(ScrollView);
  fireEvent.press(screen.getByRole('button', { name: 'Project' }));
  // Options rendered inside the body scroll view push everything below them
  // down and make the card jump; they belong to an overlay above it.
  let node = screen.getByRole('button', { name: 'Other project' }).parent;
  while (node) {
    expect(node).not.toBe(body);
    node = node.parent;
  }
  fireEvent.press(screen.getByLabelText('Close project list'));
  expect(screen.queryByRole('button', { name: 'Other project' })).toBeNull();
});
it('anchors project options below the select, or above it when the card has no room', () => {
  setup(jest.fn());
  fireEvent.press(screen.getByRole('button', { name: 'Project' }));
  expect(screen.getByTestId('project-options')).toHaveStyle({ top: 254, left: 20, width: 300 });
  fireEvent.press(screen.getByLabelText('Close project list'));
  layout = { select: [20, 200, 300, 48], cardHeight: 300 };
  fireEvent.press(screen.getByRole('button', { name: 'Project' }));
  expect(screen.getByTestId('project-options')).toHaveStyle({ bottom: 106, maxHeight: 154 });
});
it('keeps unmeasured project options out of reach instead of guessing their place', () => {
  layout = undefined;
  setup(jest.fn());
  fireEvent.press(screen.getByRole('button', { name: 'Project' }));
  // An invisible list at a fallback spot would pick a project nobody saw.
  expect(screen.getByTestId('project-options')).toHaveStyle({ opacity: 0 });
  fireEvent.press(screen.getByRole('button', { name: 'Other project' }));
  expect(screen.getByRole('button', { name: 'Other project' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Project' })).not.toHaveTextContent(/Other project/);
});
it('keeps the retry key after an ambiguous failure and names the destination on success', async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(new Error('Network interrupted'))
    .mockResolvedValue(result);
  const { props } = setup(request);
  selectTarget();
  move();
  await screen.findByText('Network interrupted');
  move();
  await screen.findByText(/Moved to Target project/);
  expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  expect(props.onChanged).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Not copied: private/)).toBeTruthy();
});
it('requires explicit acknowledgement before leaving source commits', async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(new VerityApiError(409, 'Commits remain', { code: 'source_commits' }))
    .mockResolvedValue(result);
  setup(request);
  selectTarget();
  move();
  const checkbox = await screen.findByRole('checkbox', { name: 'Leave commits in source project' });
  expect(screen.getByRole('button', { name: /Save and move|Retry move/ })).toBeDisabled();
  fireEvent.press(checkbox);
  move();
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1][1].onCommits).toBe('leave');
  expect(request.mock.calls[1][1].operationId).not.toBe(request.mock.calls[0][1].operationId);
});
it('reconciles an interrupted move after a busy retry and reopening the dialog', async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(new Error('Network interrupted'))
    .mockRejectedValueOnce(new VerityApiError(409, 'Move still running', { code: 'busy' }))
    .mockResolvedValue(result);
  const first = setup(request, 'reopened');
  selectTarget();
  move();
  await screen.findByText('Network interrupted');
  move();
  await screen.findByText(/This session or project is busy/);
  fireEvent.press(screen.getByText('Cancel'));
  first.unmount();
  render(<SessionSettingsDialog {...first.props} />);
  expect(screen.getByRole('button', { name: 'Project' })).toBeDisabled();
  move();
  await screen.findByText(/Moved to Target project/);
  expect(request.mock.calls[2]).toEqual(request.mock.calls[0]);
});
it.each([
  [new VerityApiError(404, 'Not Found'), /Update the Verity server/],
  [
    new VerityApiError(404, 'Session not found.', { code: 'not_found' }),
    /session no longer exists/,
  ],
  [new Error('unknown'), /move could not be confirmed/],
])('shows an actionable message for %s', async (error, message) => {
  const { props } = setup(jest.fn().mockRejectedValue(error));
  selectTarget();
  move();
  await screen.findByText(message);
  expect(props.onChanged).not.toHaveBeenCalled();
});

it('saves a name without moving and closes the same dialog', async () => {
  const request = jest.fn();
  const { props } = setup(request);
  fireEvent.changeText(screen.getByLabelText('Session name'), 'New name');
  fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  expect(props.client.renameSession).toHaveBeenCalledWith('s', 'New name');
  expect(request).not.toHaveBeenCalled();
});
it('retains the saved name when moving fails and retries only the move', async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(new Error('Network interrupted'))
    .mockResolvedValue(result);
  const { props } = setup(request);
  fireEvent.changeText(screen.getByLabelText('Session name'), 'New name');
  selectTarget();
  move();
  await screen.findByText('Network interrupted');
  expect(props.client.renameSession).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Session name')).toHaveDisplayValue('New name');
  move();
  await screen.findByText(/Moved to Target project/);
  expect(props.client.renameSession).toHaveBeenCalledTimes(1);
});
it('does not attempt a move when renaming fails', async () => {
  const request = jest.fn();
  const { props } = setup(request);
  jest.mocked(props.client.renameSession).mockRejectedValueOnce(new Error('offline'));
  fireEvent.changeText(screen.getByLabelText('Session name'), 'New name');
  selectTarget();
  move();
  await screen.findByText(/name could not be saved/);
  expect(request).not.toHaveBeenCalled();
});

it('locks commit acknowledgement until an interrupted move is reconciled', async () => {
  let rejectMove!: (reason: Error) => void;
  const inFlight = new Promise((_, reject) => {
    rejectMove = reject;
  });
  const request = jest
    .fn()
    .mockRejectedValueOnce(new VerityApiError(409, 'Commits remain', { code: 'source_commits' }))
    .mockReturnValueOnce(inFlight)
    .mockResolvedValue(result);
  setup(request);
  selectTarget();
  move();
  const checkbox = await screen.findByRole('checkbox', { name: 'Leave commits in source project' });
  fireEvent.press(checkbox);
  move();
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(checkbox).toBeDisabled();
  fireEvent.press(checkbox);
  await act(async () => {
    rejectMove(new Error('Network interrupted'));
  });
  await screen.findByText('Network interrupted');
  move();
  await screen.findByText(/Moved to Target project/);
  expect(request.mock.calls[2]).toEqual(request.mock.calls[1]);
});

it('locks an open project picker while moving and retains the destination on retry', async () => {
  let rejectMove!: (reason: Error) => void;
  const inFlight = new Promise((_, reject) => {
    rejectMove = reject;
  });
  const request = jest.fn().mockReturnValueOnce(inFlight).mockResolvedValue(result);
  setup(request);
  selectTarget();
  fireEvent.press(screen.getByRole('button', { name: 'Project' }));
  move();
  const other = screen.getByRole('button', { name: 'Other project' });
  expect(other).toBeDisabled();
  fireEvent.press(other);
  await act(async () => {
    rejectMove(new Error('Network interrupted'));
  });
  await screen.findByText('Network interrupted');
  expect(other).toBeDisabled();
  fireEvent.press(other);
  move();
  await screen.findByText(/Moved to Target project/);
  expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
});

it('enables Save only while the trimmed name or project has changed', () => {
  setup(jest.fn());
  // A bright no-op Save makes unchanged settings look like an unsaved edit.
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Session name'), 'New name');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  fireEvent.changeText(screen.getByLabelText('Session name'), ' Product images ');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  selectTarget();
  expect(screen.getByRole('button', { name: 'Save and move' })).toBeEnabled();
});
