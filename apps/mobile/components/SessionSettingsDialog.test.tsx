import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { VerityApiError, type VerityClient } from '@verity/mobile';
import { SessionSettingsDialog } from './SessionSettingsDialog';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => `operation-${Math.random()}`) }));
jest.mock('./Icon', () => ({ Icon: () => null }));
jest.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: jest.requireActual('../theme/tokens').darkTheme }),
}));

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

it('contains the dialog on tablets and keeps project options collapsed until requested', () => {
  setup(jest.fn());
  // Without a width cap the modal covers the entire split-view screen.
  expect(screen.getByTestId('session-settings-card')).toHaveStyle({ maxWidth: 440, width: '100%' });
  expect(screen.queryByText('Other project')).toBeNull();
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  selectTarget();
  expect(screen.queryByText('Other project')).toBeNull();
  expect(screen.getByRole('button', { name: 'Project' })).toHaveAccessibilityValue({
    text: 'Target project',
  });
  expect(screen.getByRole('button', { name: /Save and move|Retry move/ })).toBeEnabled();
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
