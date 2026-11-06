// A project's Tasks: the row on its Overview and the screen it opens
// (app/project/[id]/tasks.tsx, TaskListBody with scope="project").
//
// What is worth guarding: the screen is the operator's own list for this one
// project plus its issues — not the agents' working steps, and not other
// projects' tasks, which the panel behind the V does show.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({ id: 'p1' }),
  Stack: {
    Screen: ({ options }: { options?: { headerRight?: () => unknown } }) =>
      options?.headerRight?.() ?? null,
  },
}));
jest.mock('../lib/tasksStore', () => ({
  useTasks: jest.fn(),
  patchTask: jest.fn(),
  refreshTasks: jest.fn(),
  removeTask: jest.fn(),
  resolveTaskConflict: jest.fn(),
}));
jest.mock('../lib/client', () => ({ createVerityClient: jest.fn(() => null) }));
const mockEnabled = { value: true };
jest.mock('../lib/taskPreferences', () => ({
  useTaskPreferences: () => ({
    tab: 'agent',
    projectId: null,
    loaded: true,
    enabled: mockEnabled.value,
  }),
  saveTaskPreferences: jest.fn(async () => undefined),
}));
jest.mock('../lib/taskDispatch', () => ({ dispatchTasks: jest.fn() }));
jest.mock('../lib/taskAttachments', () => ({ openTaskAttachment: jest.fn() }));
jest.mock('../lib/sharedTaskContext', () => ({
  useTaskContext: () => ({ projects: [], sessions: [], projectsScope: null }),
}));
jest.mock('../lib/voiceShortcut', () => ({ dispatchVerityShortcut: jest.fn() }));

import type { Task, VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import ProjectTasksScreen from '../app/project/[id]/tasks';
import { TaskListBody } from '../components/TasksPanel';
import { ProjectTasksRow, projectTasksLine } from '../components/project/ProjectTasksRow';
import { useTasks } from '../lib/tasksStore';
import { dispatchVerityShortcut } from '../lib/voiceShortcut';

function task(id: string, over: Partial<Task>): Task {
  return {
    id,
    title: id,
    detail: null,
    projectId: 'p1',
    sessionId: null,
    sourceSessionId: null,
    origin: 'user',
    attachments: [],
    status: 'open',
    result: null,
    sort: 0,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: '',
    completedAt: null,
    ...over,
  };
}

const projects = [
  { id: 'p1', owner: 'acme', repo: 'site', kind: 'local' },
  { id: 'p2', owner: 'acme', repo: 'blog', kind: 'local' },
] as never[];

const tasks = [
  task('Ship the pricing page', {}),
  task('Other project chore', { projectId: 'p2' }),
  task('Agent step', { origin: 'agent', sessionId: 's1' }),
  task('Already done', { status: 'done' }),
  task('Done elsewhere', { status: 'done', projectId: 'p2' }),
];

beforeEach(() => {
  mockEnabled.value = true;
  jest.mocked(useTasks).mockReturnValue({ tasks, pending: [], conflicts: [] } as never);
});

it('words the Overview row from open tasks and issues', () => {
  expect(projectTasksLine(0, null)).toBe('No open tasks');
  expect(projectTasksLine(3, null)).toBe('3 open');
  expect(projectTasksLine(3, 1)).toBe('3 open · 1 GitHub issue');
  expect(projectTasksLine(1, 5)).toBe('1 open · 5 GitHub issues');
});

it('counts this project’s open own tasks and opens its Tasks screen', async () => {
  const client = {
    listProjectGitHubIssues: jest
      .fn()
      .mockResolvedValue({ connected: true, issues: [{}, {}], viewerLogin: 'me' }),
  } as unknown as VerityClient;
  render(<ProjectTasksRow client={client} projectId="p1" />);
  await act(async () => undefined);
  // Not the other project's chore, the agent's step or the done task.
  expect(await screen.findByText('1 open · 2 GitHub issues')).toBeTruthy();
  fireEvent.press(screen.getByText('Tasks'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/project/[id]/tasks',
    params: { id: 'p1' },
  });
});

it('keeps a project’s list to its own tasks, without the agents’ steps', () => {
  render(
    <TaskListBody
      context={{ projectId: 'p1', sessionId: 's1' }}
      projects={projects}
      scope="project"
      onLeave={jest.fn()}
    />,
  );
  // The remembered Agent tab does not apply here.
  expect(screen.queryByRole('tab', { name: 'Agent' })).toBeNull();
  expect(screen.getByDisplayValue('Ship the pricing page')).toBeTruthy();
  expect(screen.queryByDisplayValue('Other project chore')).toBeNull();
  // Not even as a folded group, as the panel lists other projects.
  expect(screen.queryByText('blog')).toBeNull();
  expect(screen.queryByText('Assign to project')).toBeNull();
  expect(screen.queryByDisplayValue('Agent step')).toBeNull();
});

it('still shows the agents’ steps in the panel behind the V', () => {
  render(
    <TaskListBody
      context={{ projectId: 'p1', sessionId: 's1' }}
      projects={projects}
      onLeave={jest.fn()}
    />,
  );
  expect(screen.getByRole('tab', { name: 'Agent' })).toBeTruthy();
});

it('counts only this project’s finished tasks behind Show done', () => {
  render(
    <TaskListBody
      context={{ projectId: 'p1', sessionId: null }}
      projects={projects}
      scope="project"
      onLeave={jest.fn()}
    />,
  );
  expect(screen.getByText('Show done (1)')).toBeTruthy();
});

it('leaves the row out while tasks are switched off', () => {
  mockEnabled.value = false;
  render(<ProjectTasksRow client={{} as VerityClient} projectId="p1" />);
  expect(screen.queryByText('Tasks')).toBeNull();
});

it('adds a task through Verity from the screen’s header', () => {
  render(<ProjectTasksScreen />);
  expect(screen.getByTestId('project-tasks')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Add task'));
  expect(dispatchVerityShortcut).toHaveBeenCalledWith({ mode: 'text' });
});
