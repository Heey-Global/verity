jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
import { render, fireEvent } from '@testing-library/react-native';
import { TasksPanel } from './TasksPanel';
import { patchTask, useTasks } from '../lib/tasksStore';
import type { Task } from '@verity/mobile';
jest.mock('../lib/tasksStore', () => ({
  useTasks: jest.fn(),
  patchTask: jest.fn(),
  refreshTasks: jest.fn(),
  removeTask: jest.fn(),
  resolveTaskConflict: jest.fn(),
}));
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
it('offers no session action for General', () => {
  jest.mocked(useTasks).mockReturnValue({ tasks: [task], pending: [], conflicts: [] });
  const ui = render(<TasksPanel {...props} />);
  expect(ui.queryByText(/New Session/)).toBeNull();
  expect(ui.queryByText(/This Session/)).toBeNull();
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
it('keeps the agent’s steps in a collapsed section without implement buttons', () => {
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
  fireEvent.press(ui.getByLabelText('Agent steps · 1/2'));
  expect(ui.getByText('Rate-limit login')).toBeTruthy();
  expect(ui.queryByText('Other session step')).toBeNull();
  expect(ui.queryByText(/New Session/)).toBeNull();
  // Step actions live in the shared "…" card, not inline chips.
  expect(ui.queryByText('Move to my tasks')).toBeNull();
  expect(ui.getAllByA11yHint('Opens step actions')).toHaveLength(1);
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
