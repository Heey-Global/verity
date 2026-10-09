import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { VerityApiError, type VerityClient } from '@verity/mobile';
import { Modal, ScrollView, View } from 'react-native';
import { SessionSettingsDialog } from './SessionSettingsDialog';
import { isLinkableSession } from '../lib/sessionLinks';

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
function setup(
  moveSession: jest.Mock,
  sessionId = 's',
  initialLinks?: Awaited<ReturnType<VerityClient['listSessionLinks']>>,
  loadLinks?: jest.Mock,
) {
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
      listSessionLinks:
        loadLinks ??
        jest.fn(() =>
          initialLinks ? Promise.resolve(initialLinks) : new Promise(() => undefined),
        ),
      linkSessions: jest.fn().mockResolvedValue(undefined),
      unlinkSessions: jest.fn().mockResolvedValue(undefined),
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

it('links a chosen session without changing the name or project', async () => {
  const view = setup(jest.fn(), 's', []);
  await act(async () => undefined);
  const client = view.props.client as jest.Mocked<VerityClient>;
  view.rerender(
    <SessionSettingsDialog
      {...view.props}
      linkableSessions={[
        { id: 'peer', name: 'Backend work', projectId: 'b', projectName: 'Target project' },
      ]}
    />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Link a session' }));
  fireEvent.press(screen.getByRole('button', { name: 'Link Backend work' }));
  expect(client.linkSessions).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Done linking' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(client.linkSessions).toHaveBeenCalledWith('s', 'peer'));
  expect(client.renameSession).not.toHaveBeenCalled();
  expect(client.moveSession).not.toHaveBeenCalled();
});

it.each(['local', 'control_plane'] as const)(
  'finds and links another session in the current %s project while excluding itself',
  async (kind) => {
    const view = setup(jest.fn(), 's', []);
    const client = view.props.client as jest.Mocked<VerityClient>;
    const candidates = [
      { sessionId: 's', name: 'Product images', projectId: 'a', projectName: 'Source project' },
      { sessionId: 'peer', name: 'Backend work', projectId: 'a', projectName: 'Source project' },
      { sessionId: 'docs', name: 'Docs refresh', projectId: 'b', projectName: 'Target project' },
    ];
    const linkableSessions = candidates
      .filter((candidate) =>
        isLinkableSession(candidate, 's', [
          { id: 'a', state: 'active', kind },
          { id: 'b', state: 'active', kind: 'local' },
        ]),
      )
      .map((candidate) => ({ ...candidate, id: candidate.sessionId }));
    view.rerender(<SessionSettingsDialog {...view.props} linkableSessions={linkableSessions} />);
    await act(async () => undefined);
    fireEvent.press(screen.getByRole('button', { name: 'Link a session' }));
    expect(screen.queryByRole('button', { name: 'Link Product images' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Link Docs refresh' })).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Search sessions'), 'Source project');
    expect(screen.queryByRole('button', { name: 'Link Docs refresh' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Link Backend work' }));
    expect(client.linkSessions).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'Done linking' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.linkSessions).toHaveBeenCalledWith('s', 'peer'));
  },
);

it('finds a session by search and keeps the link view open to link more', async () => {
  const view = setup(jest.fn(), 's', []);
  const client = view.props.client as jest.Mocked<VerityClient>;
  view.rerender(
    <SessionSettingsDialog
      {...view.props}
      linkableSessions={[
        { id: 'peer', name: 'Backend work', projectId: 'b', projectName: 'Target project' },
        { id: 'docs', name: 'Docs refresh', projectId: 'c', projectName: 'Other project' },
      ]}
    />,
  );
  await act(async () => undefined);
  fireEvent.press(screen.getByRole('button', { name: 'Link a session' }));
  // Every candidate is one tap away: no project step to open before a session shows.
  expect(screen.getByRole('button', { name: 'Link Docs refresh' })).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Search sessions'), 'backend');
  expect(screen.queryByRole('button', { name: 'Link Docs refresh' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Link Backend work' }));
  expect(client.linkSessions).not.toHaveBeenCalled();
  // Linking must not bounce the operator back to settings, or linking a second
  // session means finding the entry point again.
  expect(await screen.findByRole('button', { name: 'Backend work, linked' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Done linking' }));
  expect(screen.getByRole('button', { name: 'Disconnect Backend work' })).toBeTruthy();
});

it('returns from the link view on Android back instead of closing the dialog', async () => {
  const { props } = setup(jest.fn(), 's', []);
  await act(async () => undefined);
  fireEvent.press(screen.getByRole('button', { name: 'Link a session' }));
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(props.onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Session name')).toBeTruthy();
});

it('reports why the server refused a link where it can be seen', async () => {
  const view = setup(jest.fn(), 's', []);
  await act(async () => undefined);
  const client = view.props.client as jest.Mocked<VerityClient>;
  client.linkSessions.mockRejectedValue(
    new VerityApiError(400, 'both sessions must belong to active projects'),
  );
  view.rerender(
    <SessionSettingsDialog
      {...view.props}
      linkableSessions={[
        { id: 'peer', name: 'Backend work', projectId: 'b', projectName: 'Target project' },
      ]}
    />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Link a session' }));
  fireEvent.press(screen.getByRole('button', { name: 'Link Backend work' }));
  fireEvent.press(screen.getByRole('button', { name: 'Done linking' }));
  fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not save session links: both sessions must belong to active projects.',
  );
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

it('discards added links on Cancel and clears dirty state when an addition is removed', async () => {
  const view = setup(jest.fn(), 's', []);
  await act(async () => undefined);
  const client = view.props.client as jest.Mocked<VerityClient>;
  view.rerender(
    <SessionSettingsDialog
      {...view.props}
      linkableSessions={[
        { id: 'peer', name: 'Backend work', projectId: 'a', projectName: 'Source project' },
      ]}
    />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Link a session' }));
  fireEvent.press(screen.getByRole('button', { name: 'Link Backend work' }));
  fireEvent.press(screen.getByRole('button', { name: 'Done linking' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Project' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Disconnect Backend work' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Link a session' }));
  fireEvent.press(screen.getByRole('button', { name: 'Link Backend work' }));
  fireEvent.press(screen.getByRole('button', { name: 'Done linking' }));
  fireEvent.press(screen.getByText('Cancel'));
  expect(view.props.onClose).toHaveBeenCalled();
  expect(client.linkSessions).not.toHaveBeenCalled();
  expect(client.unlinkSessions).not.toHaveBeenCalled();
});

it('stages removals and retries only the remaining writes after a partial save', async () => {
  const view = setup(jest.fn(), 's', [
    { sessionId: 'peer', name: 'Backend work', projectId: 'a', projectName: 'Source project' },
    { sessionId: 'docs', name: 'Docs refresh', projectId: 'a', projectName: 'Source project' },
  ]);
  await act(async () => undefined);
  const client = view.props.client as jest.Mocked<VerityClient>;
  client.unlinkSessions
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  fireEvent.press(screen.getByRole('button', { name: 'Disconnect Backend work' }));
  fireEvent.press(screen.getByRole('button', { name: 'Disconnect Docs refresh' }));
  expect(client.unlinkSessions).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Session links could not be saved. Please try again.',
  );
  expect(view.props.onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(view.props.onClose).toHaveBeenCalled());
  expect(client.unlinkSessions.mock.calls).toEqual([
    ['s', 'peer'],
    ['s', 'docs'],
    ['s', 'docs'],
  ]);
});

it('discards a pending removal on Cancel', async () => {
  const view = setup(jest.fn(), 's', [
    { sessionId: 'peer', name: 'Backend work', projectId: 'a', projectName: 'Source project' },
  ]);
  await act(async () => undefined);
  fireEvent.press(screen.getByRole('button', { name: 'Disconnect Backend work' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  fireEvent.press(screen.getByText('Cancel'));
  expect(view.props.client.unlinkSessions).not.toHaveBeenCalled();
  expect(view.props.onClose).toHaveBeenCalled();
});

it('retries a failed initial link load without losing name edits', async () => {
  const load = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
  setup(jest.fn(), 's', [], load);
  fireEvent.changeText(screen.getByLabelText('Session name'), 'Updated name');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Linked sessions could not be loaded.',
  );
  expect(screen.getByRole('button', { name: 'Link a session' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Retry loading linked sessions' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Link a session' })).toBeEnabled());
  expect(screen.getByLabelText('Session name')).toHaveDisplayValue('Updated name');
  expect(load).toHaveBeenCalledTimes(2);
});
