import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { VerityApiError, type VerityClient } from '@verity/mobile';
import { MoveSessionDialog } from './MoveSessionDialog';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => `operation-${Math.random()}`) }));
jest.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { colors: { text: '#000', background: '#fff' } } }),
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
function setup(moveSession: jest.Mock) {
  const onMoved = jest.fn();
  render(
    <MoveSessionDialog
      sessionId="s"
      projects={[{ id: 'b', name: 'Target project' }]}
      client={{ moveSession } as unknown as VerityClient}
      onClose={jest.fn()}
      onMoved={onMoved}
    />,
  );
  fireEvent.press(screen.getByText('Target project'));
  return { onMoved };
}
it('keeps the retry key after an ambiguous failure and shows retained files after success', async () => {
  const move = jest
    .fn()
    .mockRejectedValueOnce(new Error('Network interrupted'))
    .mockResolvedValue(result);
  const { onMoved } = setup(move);
  fireEvent.press(screen.getByText('Move'));
  await screen.findByText('Network interrupted');
  fireEvent.press(screen.getByText('Move'));
  await screen.findByText(/Not copied: private/);
  expect(move.mock.calls[1]).toEqual(move.mock.calls[0]);
  expect(onMoved).toHaveBeenCalledTimes(1);
});
it('requires explicit acknowledgement before leaving source commits', async () => {
  const move = jest
    .fn()
    .mockRejectedValueOnce(new VerityApiError(409, 'Commits remain', { code: 'source_commits' }))
    .mockResolvedValue(result);
  setup(move);
  fireEvent.press(screen.getByText('Move'));
  await screen.findByText('Leave commits in source project');
  expect(move).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText('Leave commits in source project'));
  fireEvent.press(screen.getByText('Move and leave commits'));
  await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
  expect(move.mock.calls[1][1].onCommits).toBe('leave');
  expect(move.mock.calls[1][1].operationId).not.toBe(move.mock.calls[0][1].operationId);
});

it('reconciles an unresolved move after closing and reopening the dialog', async () => {
  const move = jest
    .fn()
    .mockRejectedValueOnce(new Error('Network interrupted'))
    .mockResolvedValue(result);
  const client = { moveSession: move } as unknown as VerityClient;
  const props = {
    sessionId: 'reopened',
    projects: [
      { id: 'b', name: 'Target project' },
      { id: 'c', name: 'Other project' },
    ],
    client,
    onClose: jest.fn(),
    onMoved: jest.fn(),
  };
  const first = render(<MoveSessionDialog {...props} />);
  fireEvent.press(screen.getByText('Target project'));
  fireEvent.press(screen.getByText('Move'));
  await screen.findByText('Network interrupted');
  fireEvent.press(screen.getByText('Cancel'));
  first.unmount();
  render(<MoveSessionDialog {...props} />);
  fireEvent.press(screen.getByText('Other project'));
  fireEvent.press(screen.getByText('Move'));
  await screen.findByText(/Not copied: private/);
  expect(move.mock.calls[1]).toEqual(move.mock.calls[0]);
});
