import { act, fireEvent, render } from '@testing-library/react-native';
import { TaskIssuesList } from './TaskIssuesList';
import { createVerityClient } from '../lib/client';
import { dispatchTaskIssue, taskIssueRetry } from '../lib/taskIssueDispatch';
jest.mock('../lib/client', () => ({ createVerityClient: jest.fn(() => null) }));
jest.mock('../lib/taskIssueDispatch', () => ({
  dispatchTaskIssue: jest.fn(),
  taskIssueRetry: jest.fn(async () => null),
}));
const issues = Array.from({ length: 4 }, (_, index) => ({
  number: index + 1,
  title: `Issue ${index + 1}`,
  url: `https://github.com/test/repo/issues/${index + 1}`,
  labels: index === 3 ? ['bug'] : [],
  assignees: index === 0 ? ['me'] : [],
}));
it('shows three issues then expands and filters the API results', async () => {
  const ui = render(<TaskIssuesList projectId="p" issues={issues} onOpenSession={jest.fn()} />);
  await act(async () => {});
  expect(ui.queryByText('Issue 4')).toBeNull();
  fireEvent.press(ui.getByText('Show all 4 issues'));
  expect(ui.getByText('Issue 4')).toBeTruthy();
  fireEvent.press(ui.getByText('Bugs'));
  expect(ui.getByText('Issue 4')).toBeTruthy();
  expect(ui.queryByText('Issue 1')).toBeNull();
});
it('does not pretend installation authentication identifies your GitHub assignments', async () => {
  const ui = render(<TaskIssuesList projectId="p" issues={issues} onOpenSession={jest.fn()} />);
  await act(async () => {});
  expect(ui.getByLabelText('Assigned to me').props.accessibilityState.disabled).toBe(true);
});
it('offers both session actions and filters assignments when a viewer is known', async () => {
  const ui = render(
    <TaskIssuesList
      projectId="p"
      currentSessionId="s"
      issues={issues}
      viewerLogin="ME"
      onOpenSession={jest.fn()}
    />,
  );
  await act(async () => {});
  expect(ui.getAllByText('↳ This Session')).toHaveLength(3);
  expect(ui.getAllByText('+ New Session')).toHaveLength(3);
  fireEvent.press(ui.getByText('Assigned to me'));
  expect(ui.getByText('Issue 1')).toBeTruthy();
  expect(ui.queryByText('Issue 2')).toBeNull();
});

it('keeps retry available when a created issue session has an unsent initial turn', async () => {
  jest.mocked(createVerityClient).mockReturnValue({
    listSessions: jest.fn(async () => [
      { sessionId: 'created', projectId: 'p', branch: 'fix/1-keyboard', resumable: true },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  jest.mocked(taskIssueRetry).mockResolvedValue({});
  jest.mocked(dispatchTaskIssue).mockResolvedValue('created');
  const onOpen = jest.fn();
  const ui = render(<TaskIssuesList projectId="p" issues={[issues[0]!]} onOpenSession={onOpen} />);
  await act(async () => {});
  expect(ui.getByText('↳ Open session')).toBeTruthy();
  await act(async () => fireEvent.press(ui.getByText('Retry')));
  expect(dispatchTaskIssue).toHaveBeenCalledWith('p', issues[0], undefined);
  expect(onOpen).toHaveBeenCalledWith('created');
});

it('offers Retry and New Session for an unsent turn targeting another branch', async () => {
  jest.mocked(createVerityClient).mockReturnValue({
    listSessions: jest.fn(async () => [
      { sessionId: 'previous', projectId: 'p', branch: 'feat/999-unrelated', resumable: true },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  jest.mocked(taskIssueRetry).mockResolvedValue({ targetSessionId: 'previous' });
  jest.mocked(dispatchTaskIssue).mockResolvedValue('previous');
  const ui = render(
    <TaskIssuesList projectId="p" issues={[issues[0]!]} onOpenSession={jest.fn()} />,
  );
  await act(async () => {});
  expect(ui.getByText('+ New Session')).toBeTruthy();
  await act(async () => fireEvent.press(ui.getByText('Retry')));
  expect(dispatchTaskIssue).toHaveBeenLastCalledWith('p', issues[0], 'previous');
});
