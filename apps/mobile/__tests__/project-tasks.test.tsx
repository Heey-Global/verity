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
const mockTab = { value: 'agent' };
jest.mock('../lib/taskPreferences', () => ({
  useTaskPreferences: () => ({
    tab: mockTab.value,
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

import type { RepositoryIssues, Task, VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import ProjectTasksScreen from '../app/project/[id]/tasks';
import { TaskListBody } from '../components/TasksPanel';
import {
  ProjectTasksRow,
  issueSummary,
  projectTasksLine,
} from '../components/project/ProjectTasksRow';
import { createVerityClient } from '../lib/client';
import { dispatchTasks } from '../lib/taskDispatch';
import { patchTask, useTasks } from '../lib/tasksStore';
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
  mockTab.value = 'agent';
  jest.mocked(useTasks).mockReturnValue({ tasks, pending: [], conflicts: [] } as never);
});

const repository = (
  id: string,
  kind: 'github' | 'forgejo',
  issues: number | null,
): RepositoryIssues => {
  const identity = { id, name: id, kind, owner: 'acme', repo: id, isDefault: id === 'site' };
  return issues === null
    ? { ...identity, status: 'unavailable' }
    : {
        ...identity,
        status: 'ok',
        viewerLogin: null,
        issues: Array.from({ length: issues }, (_, index) => ({
          number: index + 1,
          title: `${id} issue ${String(index + 1)}`,
          url: `https://example.test/${id}/${String(index + 1)}`,
          labels: [],
          assignees: [],
        })),
      };
};

it('words the Overview row from open tasks and issues', () => {
  expect(projectTasksLine(0, null)).toBe('No open tasks');
  expect(projectTasksLine(3, null)).toBe('3 open');
  expect(projectTasksLine(3, { count: 1, host: 'GitHub' })).toBe('3 open · 1 GitHub issue');
  expect(projectTasksLine(1, { count: 5, host: 'Forgejo' })).toBe('1 open · 5 Forgejo issues');
  expect(projectTasksLine(1, { count: 5, host: null })).toBe('1 open · 5 issues');
});

// Counting only the default repository hid every other repository's issues
// from the Overview; an unavailable host must not count as zero either.
it('counts issues across the repositories that answered', () => {
  expect(issueSummary([repository('site', 'github', 2), repository('docs', 'github', 3)])).toEqual({
    count: 5,
    host: 'GitHub',
  });
  expect(
    issueSummary([repository('site', 'github', 2), repository('infra', 'forgejo', 1)]),
  ).toEqual({ count: 3, host: null });
  expect(
    issueSummary([repository('site', 'github', null), repository('infra', 'forgejo', 1)]),
  ).toEqual({ count: 1, host: 'Forgejo' });
  expect(issueSummary([repository('site', 'github', null)])).toBeNull();
});

it('counts this project’s open own tasks and opens its Tasks screen', async () => {
  const client = {
    listProjectIssues: jest.fn().mockResolvedValue([repository('site', 'github', 2)]),
  } as unknown as VerityClient;
  render(<ProjectTasksRow client={client} project={projects[0]!} />);
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
  // The remembered Agent tab does not apply here, and with Mine alone there
  // is no tab bar to choose from.
  expect(screen.queryByRole('tab', { name: 'Agent' })).toBeNull();
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.getByText('Ship the pricing page')).toBeTruthy();
  expect(screen.queryByText('Other project chore')).toBeNull();
  // Not even as a folded group, as the panel lists other projects; and the
  // project's own name is the screen it is on, not a heading inside it.
  expect(screen.queryByText('blog')).toBeNull();
  expect(screen.queryByText('site')).toBeNull();
  expect(screen.queryByText('Assign to project')).toBeNull();
  expect(screen.queryByText('Agent step')).toBeNull();
});

it('hands a task to Verity from its V and opens a running one’s session', async () => {
  const sessionTask = task('Fix the footer', { sessionId: 'work' });
  jest.mocked(useTasks).mockReturnValue({
    tasks: [...tasks, sessionTask],
    pending: [],
    conflicts: [],
  } as never);
  jest.mocked(dispatchTasks).mockResolvedValue('new-session');
  render(
    <TaskListBody
      context={{ projectId: 'p1', sessionId: null }}
      projects={projects}
      sessions={[{ sessionId: 'work', projectId: 'p1', status: 'awaiting_input' } as never]}
      scope="project"
      onLeave={jest.fn()}
    />,
  );
  // A task a session already has gets no second hand-over.
  expect(screen.queryByLabelText('Let Verity start: Fix the footer')).toBeNull();
  expect(screen.getByText('Verity is waiting for you')).toBeTruthy();
  await act(async () =>
    fireEvent.press(screen.getByLabelText('Let Verity start: Ship the pricing page')),
  );
  expect(dispatchTasks).toHaveBeenCalledWith([tasks[0]], undefined);
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/session/[id]',
    params: { id: 'new-session' },
  });
  fireEvent.press(screen.getByText('Fix the footer'));
  expect(router.push).toHaveBeenLastCalledWith({
    pathname: '/session/[id]',
    params: { id: 'work' },
  });
});

it('edits a task in a sheet opened from its row', async () => {
  jest.mocked(patchTask).mockResolvedValue(undefined as never);
  render(
    <TaskListBody
      context={{ projectId: 'p1', sessionId: null }}
      projects={projects}
      scope="project"
      onLeave={jest.fn()}
    />,
  );
  fireEvent.press(screen.getByText('Ship the pricing page'));
  fireEvent.changeText(screen.getByDisplayValue('Ship the pricing page'), 'Ship pricing v2');
  await act(async () => fireEvent.press(screen.getByText('Save')));
  expect(patchTask).toHaveBeenCalledWith(tasks[0], { title: 'Ship pricing v2' });
});

it('shows the Issues tab with one section per repository', async () => {
  mockTab.value = 'issues';
  jest.mocked(createVerityClient).mockReturnValue({
    listProjectIssues: jest
      .fn()
      .mockResolvedValue([repository('site', 'github', 1), repository('infra', 'forgejo', null)]),
    listSessions: jest.fn(async () => []),
  } as never);
  render(
    <TaskListBody
      context={{ projectId: 'p1', sessionId: null }}
      projects={projects}
      scope="project"
      onLeave={jest.fn()}
    />,
  );
  await act(async () => undefined);
  // Mixed hosts: the tab names neither.
  expect(screen.getByRole('tab', { name: 'Issues' })).toBeTruthy();
  expect(await screen.findByText('site issue 1')).toBeTruthy();
  expect(screen.getByLabelText('Let Verity fix: site issue 1')).toBeTruthy();
  // The failing host is named in its own section; the other one stays usable.
  expect(screen.getByLabelText(/^Forgejo infra/)).toBeTruthy();
  expect(screen.getByText('Could not load issues')).toBeTruthy();
  jest.mocked(createVerityClient).mockReturnValue(null);
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
  render(<ProjectTasksRow client={{} as VerityClient} project={projects[0]!} />);
  expect(screen.queryByText('Tasks')).toBeNull();
});

it('adds a task through Verity from the screen’s header', () => {
  render(<ProjectTasksScreen />);
  expect(screen.getByTestId('project-tasks')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Add task'));
  expect(dispatchVerityShortcut).toHaveBeenCalledWith({ mode: 'text' });
});

// The server reports a failing host as an unavailable repository, not as an
// error; hiding the tab then left a single-repository project without a retry.
it('keeps the Issues tab and its retry when no host answered, and keeps it while retrying', async () => {
  mockTab.value = 'issues';
  const listProjectIssues = jest
    .fn()
    .mockResolvedValueOnce([repository('site', 'github', null)])
    .mockReturnValueOnce(new Promise(() => undefined));
  jest.mocked(createVerityClient).mockReturnValue({
    listProjectIssues,
    listSessions: jest.fn(async () => []),
  } as never);
  render(
    <TaskListBody
      context={{ projectId: 'p1', sessionId: null }}
      projects={projects}
      scope="project"
      onLeave={jest.fn()}
    />,
  );
  await act(async () => undefined);
  expect(screen.getByRole('tab', { name: 'Issues' })).toBeTruthy();
  expect(screen.getByText('Could not load issues')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText('Retry')));
  expect(listProjectIssues).toHaveBeenCalledTimes(2);
  // Still on the tab while the retry is on its way.
  expect(screen.getByText('Could not load issues')).toBeTruthy();
  jest.mocked(createVerityClient).mockReturnValue(null);
});

// The project list can still be loading; the read needs only the project's id.
it('loads the issues before the project list arrived', async () => {
  mockTab.value = 'issues';
  const listProjectIssues = jest.fn().mockResolvedValue([repository('site', 'github', 1)]);
  jest.mocked(createVerityClient).mockReturnValue({
    listProjectIssues,
    listSessions: jest.fn(async () => []),
  } as never);
  render(
    <TaskListBody
      context={{ projectId: 'p1', sessionId: null }}
      projects={[]}
      scope="project"
      onLeave={jest.fn()}
    />,
  );
  await act(async () => undefined);
  expect(listProjectIssues).toHaveBeenCalledWith({ id: 'p1' });
  expect(screen.getByText('site issue 1')).toBeTruthy();
  jest.mocked(createVerityClient).mockReturnValue(null);
});
