import { fireEvent, render } from '@testing-library/react-native';
import { TaskIssuesList } from './TaskIssuesList';
jest.mock('../lib/client', () => ({ createVerityClient: () => null }));
jest.mock('../lib/taskIssueDispatch', () => ({ dispatchTaskIssue: jest.fn() }));
const issues = Array.from({ length: 4 }, (_, index) => ({
  number: index + 1,
  title: `Issue ${index + 1}`,
  url: `https://github.com/test/repo/issues/${index + 1}`,
  labels: index === 3 ? ['bug'] : [],
  assignees: index === 0 ? ['me'] : [],
}));
it('shows three issues then expands and filters the API results', () => {
  const ui = render(<TaskIssuesList projectId="p" issues={issues} onOpenSession={jest.fn()} />);
  expect(ui.queryByText('Issue 4')).toBeNull();
  fireEvent.press(ui.getByText('Show all 4 issues'));
  expect(ui.getByText('Issue 4')).toBeTruthy();
  fireEvent.press(ui.getByText('Bugs'));
  expect(ui.getByText('Issue 4')).toBeTruthy();
  expect(ui.queryByText('Issue 1')).toBeNull();
});
it('does not pretend installation authentication identifies your GitHub assignments', () => {
  const ui = render(<TaskIssuesList projectId="p" issues={issues} onOpenSession={jest.fn()} />);
  expect(ui.getByLabelText('Assigned to me').props.accessibilityState.disabled).toBe(true);
});
it('offers both session actions and filters assignments when a viewer is known', () => {
  const ui = render(
    <TaskIssuesList
      projectId="p"
      currentSessionId="s"
      issues={issues}
      viewerLogin="ME"
      onOpenSession={jest.fn()}
    />,
  );
  expect(ui.getAllByText('↳ This Session')).toHaveLength(3);
  expect(ui.getAllByText('+ New Session')).toHaveLength(3);
  fireEvent.press(ui.getByText('Assigned to me'));
  expect(ui.getByText('Issue 1')).toBeTruthy();
  expect(ui.queryByText('Issue 2')).toBeNull();
});
