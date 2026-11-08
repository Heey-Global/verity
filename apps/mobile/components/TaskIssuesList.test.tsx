import { act, fireEvent, render } from '@testing-library/react-native';
import type { RepositoryIssues } from '@verity/mobile';
import { FIRST_ISSUES, TaskIssuesList } from './TaskIssuesList';
import { createVerityClient } from '../lib/client';
import { dispatchTaskIssue, taskIssueRetry } from '../lib/taskIssueDispatch';
jest.mock('../lib/client', () => ({ createVerityClient: jest.fn(() => null) }));
jest.mock('../lib/taskIssueDispatch', () => ({
  dispatchTaskIssue: jest.fn(),
  taskIssueRetry: jest.fn(async () => null),
}));
const issues = Array.from({ length: FIRST_ISSUES + 1 }, (_, index) => ({
  number: index + 1,
  title: `Issue ${index + 1}`,
  url: `https://github.com/test/repo/issues/${index + 1}`,
  labels: index === FIRST_ISSUES ? ['bug'] : [],
  assignees: index === 0 ? ['me'] : [],
}));
const repository = (
  over: Partial<Extract<RepositoryIssues, { status: 'ok' }>> = {},
): Extract<RepositoryIssues, { status: 'ok' }> => ({
  id: 'default:p',
  name: 'test/repo',
  kind: 'github',
  owner: 'test',
  repo: 'repo',
  isDefault: true,
  status: 'ok',
  viewerLogin: null,
  issues,
  ...over,
});
const list = (repositories: RepositoryIssues[], extra: { currentSessionId?: string } = {}) => (
  <TaskIssuesList
    projectId="p"
    repositories={repositories}
    onRetry={jest.fn()}
    onOpenSession={jest.fn()}
    {...extra}
  />
);
beforeEach(() => {
  jest.mocked(createVerityClient).mockReturnValue(null);
  jest.mocked(taskIssueRetry).mockResolvedValue(null);
});

it('shows the first issues then expands and filters the API results', async () => {
  const ui = render(list([repository()]));
  await act(async () => {});
  const last = `Issue ${String(FIRST_ISSUES + 1)}`;
  expect(ui.queryByText(last)).toBeNull();
  fireEvent.press(ui.getByText(`Show all ${String(FIRST_ISSUES + 1)} issues`));
  expect(ui.getByText(last)).toBeTruthy();
  fireEvent.press(ui.getByText('Bugs'));
  expect(ui.getByText(last)).toBeTruthy();
  expect(ui.queryByText('Issue 1')).toBeNull();
});

it('does not pretend installation authentication identifies your assignments', async () => {
  const ui = render(list([repository()]));
  await act(async () => {});
  expect(ui.queryByText('Assigned to me')).toBeNull();
});

it('filters assignments when a viewer is known and offers this session', async () => {
  const ui = render(list([repository({ viewerLogin: 'ME' })], { currentSessionId: 's' }));
  await act(async () => {});
  expect(ui.getAllByText('This session')).toHaveLength(FIRST_ISSUES);
  fireEvent.press(ui.getByText('Assigned to me'));
  expect(ui.getByText('Issue 1')).toBeTruthy();
  expect(ui.queryByText('Issue 2')).toBeNull();
});

it('hands an issue to Verity with its repository', async () => {
  jest.mocked(dispatchTaskIssue).mockResolvedValue('created');
  const site = repository({ id: 'site', kind: 'forgejo', isDefault: false, issues: [issues[0]!] });
  const ui = render(list([repository({ issues: [issues[1]!] }), site]));
  await act(async () => {});
  await act(async () => fireEvent.press(ui.getByLabelText('Let Verity fix: Issue 1')));
  expect(dispatchTaskIssue).toHaveBeenCalledWith('p', issues[0], undefined, site);
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
  const main = repository({ issues: [issues[0]!] });
  const ui = render(
    <TaskIssuesList
      projectId="p"
      repositories={[main]}
      onRetry={jest.fn()}
      onOpenSession={onOpen}
    />,
  );
  await act(async () => {});
  // The session started for the issue opens from its row.
  expect(ui.getByText('In a session')).toBeTruthy();
  await act(async () => fireEvent.press(ui.getByText('Retry')));
  expect(dispatchTaskIssue).toHaveBeenCalledWith('p', issues[0], undefined, main);
  expect(onOpen).toHaveBeenCalledWith('created');
});

// Branches are cut from the default repository, so its number in another
// repository's issue must not claim the default repository's session.
it('matches sessions to issues of the default repository only', async () => {
  jest.mocked(createVerityClient).mockReturnValue({
    listSessions: jest.fn(async () => [
      { sessionId: 'created', projectId: 'p', branch: 'fix/1-keyboard', resumable: true },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  const site = repository({ id: 'site', isDefault: false, issues: [issues[0]!] });
  const ui = render(list([repository({ issues: [] }), site]));
  await act(async () => {});
  expect(ui.queryByText('In a session')).toBeNull();
  expect(ui.getByLabelText('Let Verity fix: Issue 1')).toBeTruthy();
});

it('shows an unavailable repository in its own section and retries it', async () => {
  const onRetry = jest.fn();
  const ui = render(
    <TaskIssuesList
      projectId="p"
      repositories={[
        repository({ issues: [issues[0]!] }),
        {
          id: 'infra',
          name: 'infra/deploy',
          kind: 'forgejo',
          owner: 'infra',
          repo: 'deploy',
          isDefault: false,
          status: 'unavailable',
        },
      ]}
      onRetry={onRetry}
      onOpenSession={jest.fn()}
    />,
  );
  await act(async () => {});
  expect(ui.getByText('Issue 1')).toBeTruthy();
  expect(ui.getByText('Could not load issues')).toBeTruthy();
  fireEvent.press(ui.getByText('Retry'));
  expect(onRetry).toHaveBeenCalled();
  // With several repositories each section folds.
  fireEvent.press(ui.getByLabelText('GitHub test/repo · 1 open'));
  expect(ui.queryByText('Issue 1')).toBeNull();
});
