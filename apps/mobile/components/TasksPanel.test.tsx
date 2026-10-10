jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
import { act, render, fireEvent } from '@testing-library/react-native';
import { TasksPanel } from './TasksPanel';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { dispatchTasks } from '../lib/taskDispatch';
import { saveTaskPreferences } from '../lib/taskPreferences';
import { createVerityClient } from '../lib/client';
import { patchTask, useTasks } from '../lib/tasksStore';
import type { Task } from '@verity/mobile';
jest.mock('../lib/tasksStore', () => ({
  useTasks: jest.fn(),
  patchTask: jest.fn(),
  refreshTasks: jest.fn(),
  removeTask: jest.fn(),
  resolveTaskConflict: jest.fn(),
}));
jest.mock('../lib/client', () => ({ createVerityClient: jest.fn(() => null) }));
jest.mock('../lib/taskPreferences', () => {
  const React = require('react');
  let state = { tab: 'mine', projectId: null as string | null };
  const listeners = new Set<() => void>();
  return {
    useTaskPreferences: () =>
      React.useSyncExternalStore(
        (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => state,
      ),
    saveTaskPreferences: jest.fn(async (patch: { tab?: string; projectId?: string | null }) => {
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener());
    }),
  };
});
beforeEach(() => {
  jest.mocked(dispatchTasks).mockReset();
  jest.mocked(router.push).mockClear();
  props.onClose.mockClear();
  jest.mocked(patchTask).mockClear();
  void saveTaskPreferences({ tab: 'mine', projectId: null });
});
jest.mock('../lib/taskDispatch', () => ({ dispatchTasks: jest.fn() }));
jest.mock('../lib/taskAttachments', () => ({ openTaskAttachment: jest.fn() }));
const task: Task = {
  id: 't',
  title: 'General outcome',
  detail: null,
  projectId: null,
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
};
const props = {
  context: { projectId: null, sessionId: null },
  projects: [],
  side: 'right' as const,
  y: 100,
  onClose: jest.fn(),
  onCapture: jest.fn(),
};
it('offers no session action for tasks awaiting project assignment', () => {
  jest.mocked(useTasks).mockReturnValue({ tasks: [task], pending: [], conflicts: [] });
  const ui = render(<TasksPanel {...props} />);
  expect(ui.queryByText(/New Session/)).toBeNull();
  expect(ui.queryByText(/This Session/)).toBeNull();
});
it.each([
  ['+ New Session', 'Starting new session…', undefined],
  ['↳ This Session', 'Sending task to session…', 's'],
])('shows immediate feedback for %s until dispatch finishes', async (label, status, target) => {
  let resolve!: (id: string) => void;
  jest.mocked(dispatchTasks).mockReturnValue(new Promise((done) => (resolve = done)));
  const projectTask = { ...task, projectId: 'p' };
  jest.mocked(useTasks).mockReturnValue({ tasks: [projectTask], pending: [], conflicts: [] });
  const ui = render(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 's' }} />);
  fireEvent.press(ui.getByText(label));
  expect(ui.getByText(status)).toBeTruthy();
  expect(ui.getByRole('button', { name: '+ New Session' })).toBeDisabled();
  expect(ui.getByRole('button', { name: '↳ This Session' })).toBeDisabled();
  fireEvent.press(ui.getByText(label));
  expect(dispatchTasks).toHaveBeenCalledTimes(1);
  expect(dispatchTasks).toHaveBeenCalledWith([projectTask], target);
  expect(props.onClose).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
  await act(async () => resolve('created'));
  expect(ui.queryByText(status)).toBeNull();
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/session/[id]',
    params: { id: 'created' },
  });
});
it('clears dispatch feedback on failure and allows retry without closing the panel', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  let reject!: (error: Error) => void;
  jest.mocked(dispatchTasks).mockReturnValue(new Promise((_, fail) => (reject = fail)));
  jest.mocked(useTasks).mockReturnValue({
    tasks: [{ ...task, projectId: 'p' }],
    pending: [],
    conflicts: [],
  });
  const ui = render(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 's' }} />);
  fireEvent.press(ui.getByText('+ New Session'));
  await act(async () => reject(new Error('Connection lost')));
  expect(ui.queryByText('Starting new session…')).toBeNull();
  expect(alert).toHaveBeenCalledWith('Task action failed', 'Connection lost');
  expect(props.onClose).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
  expect(ui.getByRole('button', { name: '+ New Session' })).not.toBeDisabled();
  jest.mocked(dispatchTasks).mockResolvedValue('retry');
  await act(async () => fireEvent.press(ui.getByText('+ New Session')));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/session/[id]', params: { id: 'retry' } });
  alert.mockRestore();
});
it('offers both actions only in the matching project session', () => {
  jest
    .mocked(useTasks)
    .mockReturnValue({ tasks: [{ ...task, projectId: 'p' }], pending: [], conflicts: [] });
  const ui = render(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 's' }} />);
  expect(ui.getByText('+ New Session')).toBeTruthy();
  expect(ui.getByText('↳ This Session')).toBeTruthy();
  ui.rerender(<TasksPanel {...props} context={{ projectId: 'other', sessionId: 's2' }} />);
  fireEvent.press(ui.getByLabelText('Project · 1'));
  expect(ui.getByText('+ New Session')).toBeTruthy();
  expect(ui.queryByText('↳ This Session')).toBeNull();
});
it('shows where an assigned task went instead of offering to assign it again', () => {
  jest.mocked(useTasks).mockReturnValue({
    tasks: [
      { ...task, id: 'mine', title: 'Already here', projectId: 'p', sessionId: 's' },
      { ...task, id: 'theirs', title: 'Elsewhere', projectId: 'p', sessionId: 'other' },
    ],
    pending: [],
    conflicts: [],
  });
  const ui = render(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 's' }} />);
  expect(ui.getByText(/in this session/)).toBeTruthy();
  expect(ui.queryByText(/New Session/)).toBeNull();
  expect(ui.queryByText(/This Session/)).toBeNull();
  expect(ui.getAllByText('↳ Open session')).toHaveLength(1);
});
it('separates agent steps and includes completed steps in the current session', () => {
  jest.mocked(useTasks).mockReturnValue({
    tasks: [
      {
        ...task,
        id: 'step1',
        title: 'Rotate tokens',
        origin: 'agent',
        projectId: 'p',
        sessionId: 's',
        status: 'done',
      },
      {
        ...task,
        id: 'step2',
        title: 'Rate-limit login',
        origin: 'agent',
        projectId: 'p',
        sessionId: 's',
      },
      {
        ...task,
        id: 'elsewhere',
        title: 'Other session step',
        origin: 'agent',
        projectId: 'p',
        sessionId: 'x',
      },
    ],
    pending: [],
    conflicts: [],
  });
  const ui = render(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 's' }} />);
  // Nothing of the agent's shows in the operator's list; the section is shut.
  expect(ui.queryByText('Rate-limit login')).toBeNull();
  fireEvent.press(ui.getByLabelText('Agent'));
  expect(ui.getByText('Rotate tokens')).toBeTruthy();
  expect(ui.getByText('Rate-limit login')).toBeTruthy();
  expect(ui.queryByText('Other session step')).toBeNull();
  expect(ui.queryByText(/New Session/)).toBeNull();
  // Step actions live in the shared "…" card, not inline chips.
  expect(ui.queryByText('Move to my tasks')).toBeNull();
  expect(ui.getAllByA11yHint('Opens step actions')).toHaveLength(2);
  expect(ui.queryByLabelText('Session · 1')).toBeNull();
  expect(ui.getAllByText('1/2')).toHaveLength(2);
  ui.rerender(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 'x' }} />);
  expect(ui.getByText('Other session step')).toBeTruthy();
  expect(ui.queryByText('Rotate tokens')).toBeNull();
  expect(ui.queryByText('Rate-limit login')).toBeNull();
  expect(ui.getAllByText('0/1')).toHaveLength(2);
  ui.rerender(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 'empty' }} />);
  expect(ui.queryByText('Other session step')).toBeNull();
  expect(ui.queryByText('This session')).toBeNull();
  expect(ui.getByText('0/0')).toBeTruthy();
  ui.rerender(<TasksPanel {...props} />);
  expect(ui.queryByLabelText('Agent')).toBeNull();
  expect(ui.getByLabelText('Mine').props.accessibilityState.selected).toBe(true);
  expect(ui.queryByLabelText('Session · 1')).toBeNull();
  expect(ui.queryByLabelText('Session · 2')).toBeNull();
  expect(ui.queryByText('Other session step')).toBeNull();
  expect(ui.queryByText('Rotate tokens')).toBeNull();
  expect(ui.queryByText('Rate-limit login')).toBeNull();
});
it('edits the text in place and saves it when the field is left', () => {
  jest.mocked(useTasks).mockReturnValue({ tasks: [task], pending: [], conflicts: [] });
  jest.mocked(patchTask).mockResolvedValue(undefined as never);
  const ui = render(<TasksPanel {...props} />);
  const field = ui.getByDisplayValue('General outcome');
  fireEvent(field, 'focus');
  fireEvent.changeText(field, '  Sharper outcome ');
  expect(patchTask).not.toHaveBeenCalled();
  fireEvent(field, 'blur');
  expect(patchTask).toHaveBeenCalledWith(task, { title: 'Sharper outcome' });
  // Emptying the field restores the text instead of saving nothing.
  jest.mocked(patchTask).mockClear();
  fireEvent(field, 'focus');
  fireEvent.changeText(field, '   ');
  fireEvent(field, 'blur');
  expect(patchTask).not.toHaveBeenCalled();
  expect(ui.getByDisplayValue('General outcome')).toBeTruthy();
});
it('keeps steps of ended sessions out of the operator list', () => {
  jest.mocked(useTasks).mockReturnValue({
    tasks: [
      { ...task, id: 'mine', title: 'My capture', projectId: 'p' },
      {
        ...task,
        id: 'orphan',
        title: 'Orphaned step',
        origin: 'agent',
        projectId: 'p',
        status: 'in_progress',
      },
    ],
    pending: [],
    conflicts: [],
  });
  const ui = render(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 's' }} />);
  expect(ui.getByDisplayValue('My capture')).toBeTruthy();
  // Their session is gone, so they were dropped server-side; never list them.
  expect(ui.queryByText('Orphaned step')).toBeNull();
});

it('does not overwrite a concurrent title on blur without typing', () => {
  jest.mocked(patchTask).mockClear();
  jest.mocked(useTasks).mockReturnValue({ tasks: [task], pending: [], conflicts: [] });
  const ui = render(<TasksPanel {...props} />);
  fireEvent(ui.getByLabelText('Task text'), 'focus');
  jest.mocked(useTasks).mockReturnValue({
    tasks: [{ ...task, title: 'Remote edit', revision: 2 }],
    pending: [],
    conflicts: [],
  });
  ui.rerender(<TasksPanel {...props} />);
  fireEvent(ui.getByLabelText('Task text'), 'blur');
  expect(patchTask).not.toHaveBeenCalled();
  expect(ui.getByDisplayValue('Remote edit')).toBeTruthy();
});
it('uses the revision at focus when saving across a concurrent edit', () => {
  jest.mocked(patchTask).mockClear().mockResolvedValue(undefined);
  jest.mocked(useTasks).mockReturnValue({ tasks: [task], pending: [], conflicts: [] });
  const ui = render(<TasksPanel {...props} />);
  fireEvent(ui.getByLabelText('Task text'), 'focus');
  fireEvent.changeText(ui.getByLabelText('Task text'), 'My edit');
  jest.mocked(useTasks).mockReturnValue({
    tasks: [{ ...task, title: 'Remote edit', revision: 2 }],
    pending: [],
    conflicts: [],
  });
  ui.rerender(<TasksPanel {...props} />);
  fireEvent(ui.getByLabelText('Task text'), 'blur');
  expect(patchTask).toHaveBeenCalledWith(task, { title: 'My edit' });
});

it('keeps a new draft when an earlier save fails', async () => {
  let rejectSave!: (error: Error) => void;
  jest.mocked(patchTask).mockReturnValueOnce(
    new Promise((_, reject) => {
      rejectSave = reject;
    }),
  );
  jest.mocked(useTasks).mockReturnValue({ tasks: [task], pending: [], conflicts: [] });
  const ui = render(<TasksPanel {...props} />);
  const field = ui.getByLabelText('Task text');
  fireEvent(field, 'focus');
  fireEvent.changeText(field, 'First edit');
  fireEvent(field, 'blur');
  fireEvent(field, 'focus');
  fireEvent.changeText(field, 'New draft');
  await act(async () => {
    rejectSave(new Error('Offline'));
  });
  expect(ui.getByDisplayValue('New draft')).toBeTruthy();
});

it('starts legacy tasks collapsed when a project is current and removes empty copy', () => {
  jest.mocked(useTasks).mockReturnValue({
    tasks: [task, { ...task, id: 'p-task', title: 'Project task', projectId: 'p' }],
    pending: [],
    conflicts: [],
  });
  const ui = render(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 's' }} />);
  expect(ui.queryByDisplayValue(task.title)).toBeNull();
  fireEvent.press(ui.getByLabelText('Assign to project · 1'));
  expect(ui.getByDisplayValue(task.title)).toBeTruthy();
  expect(ui.queryByText(/Nothing.*here|Nothing captured/)).toBeNull();
});
it('remembers Agent across reopening and falls back from unavailable Issues', async () => {
  jest.mocked(useTasks).mockReturnValue({ tasks: [], pending: [], conflicts: [] });
  const sessionContext = { projectId: 'p', sessionId: 's' };
  let ui = render(<TasksPanel {...props} context={sessionContext} />);
  fireEvent.press(ui.getByLabelText('Agent'));
  expect(saveTaskPreferences).toHaveBeenCalledWith({ tab: 'agent' });
  ui.unmount();
  ui = render(<TasksPanel {...props} context={sessionContext} />);
  expect(ui.getByLabelText('Agent').props.accessibilityState.selected).toBe(true);
  ui.rerender(<TasksPanel {...props} />);
  expect(ui.queryByLabelText('Agent')).toBeNull();
  expect(ui.getByLabelText('Mine').props.accessibilityState.selected).toBe(true);
  ui.unmount();
  await saveTaskPreferences({ tab: 'issues' });
  ui = render(<TasksPanel {...props} />);
  expect(ui.getByLabelText('Mine').props.accessibilityState.selected).toBe(true);
  expect(ui.queryByLabelText('GitHub Issues')).toBeNull();
});
it('shows GitHub Issues only for a connected project and hides Mine while selected', async () => {
  jest
    .mocked(useTasks)
    .mockReturnValue({ tasks: [{ ...task, projectId: 'p' }], pending: [], conflicts: [] });
  jest.mocked(createVerityClient).mockReturnValue({
    listProjectGitHubIssues: jest.fn(async () => ({
      connected: true,
      viewerLogin: null,
      issues: [],
    })),
    listSessions: jest.fn(async () => []),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  const ui = render(<TasksPanel {...props} context={{ projectId: 'p', sessionId: 's' }} />);
  await act(async () => {});
  fireEvent.press(ui.getByLabelText('GitHub Issues'));
  expect(ui.queryByDisplayValue(task.title)).toBeNull();
  expect(ui.getByText('Assigned to me')).toBeTruthy();
  ui.rerender(<TasksPanel {...props} />);
  expect(ui.queryByLabelText('GitHub Issues')).toBeNull();
  expect(ui.getByLabelText('Mine').props.accessibilityState.selected).toBe(true);
  jest.mocked(createVerityClient).mockReturnValue(null);
});

it('selects a project outside a session and remembers it for capture', async () => {
  jest
    .mocked(useTasks)
    .mockReturnValue({ tasks: [{ ...task, projectId: 'p' }], pending: [], conflicts: [] });
  const ui = render(
    <TasksPanel
      {...props}
      projects={[
        {
          id: 'p',
          owner: '',
          repo: 'Project',
          kind: 'local',
          containerName: 'p',
          imageRef: null,
          state: 'active',
          provisionError: null,
          createdAt: '',
          updatedAt: '',
        },
      ]}
    />,
  );
  expect(ui.queryByDisplayValue(task.title)).toBeNull();
  await act(async () => fireEvent.press(ui.getAllByText('Project')[0]!));
  expect(ui.getByDisplayValue(task.title)).toBeTruthy();
  expect(saveTaskPreferences).toHaveBeenCalledWith({ projectId: 'p' });
  expect(ui.queryByText('General')).toBeNull();
});

it('keeps the full description behind an accessible expandable control', () => {
  const detail = 'The complete original spoken request with all its context.';
  jest
    .mocked(useTasks)
    .mockReturnValue({ tasks: [{ ...task, detail }], pending: [], conflicts: [] });
  const ui = render(<TasksPanel {...props} />);
  expect(ui.queryByText(detail)).toBeNull();
  fireEvent.press(ui.getByText('Show description'));
  expect(ui.getByText(detail)).toBeTruthy();
  expect(
    ui.getByRole('button', { name: 'Hide description' }).props.accessibilityState.expanded,
  ).toBe(true);
  fireEvent.press(ui.getByText('Hide description'));
  expect(ui.queryByText(detail)).toBeNull();
});

it.each(['pending', 'failed'] as const)(
  'shows only the original description while title generation is %s',
  (titleGenerationStatus) => {
    const detail = 'Please make the spoken tasks easier to read while preserving all the details.';
    jest.mocked(useTasks).mockReturnValue({
      tasks: [{ ...task, title: 'Internal fallback', detail, titleGenerationStatus }],
      pending: [],
      conflicts: [],
    });
    const ui = render(<TasksPanel {...props} />);
    expect(ui.getByDisplayValue(detail)).toBeTruthy();
    expect(ui.queryByDisplayValue('Internal fallback')).toBeNull();
    expect(ui.queryByText('Show description')).toBeNull();
    jest.mocked(useTasks).mockReturnValue({
      tasks: [{ ...task, title: 'Improve spoken tasks', detail, titleGenerationStatus: 'ready' }],
      pending: [],
      conflicts: [],
    });
    ui.rerender(<TasksPanel {...props} />);
    expect(ui.getByDisplayValue('Improve spoken tasks')).toBeTruthy();
    expect(ui.queryByDisplayValue(detail)).toBeNull();
    fireEvent.press(ui.getByText('Show description'));
    expect(ui.getByText(detail)).toBeTruthy();
  },
);
