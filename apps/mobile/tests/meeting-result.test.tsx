import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MeetingResult } from '../components/meeting/MeetingResult';
import { createVerityClient, getActiveMeetingServerId } from '../lib/client';
import { refreshTasks } from '../lib/tasksStore';

jest.mock('../lib/client', () => ({
  createVerityClient: jest.fn(),
  getActiveMeetingServerId: jest.fn(),
}));
jest.mock('../lib/tasksStore', () => ({ refreshTasks: jest.fn() }));

const ready = {
  meetingId: 'm',
  revision: 1,
  status: 'ready' as const,
  title: 'Release',
  summary: 'We will ship Friday.',
  decisions: [{ id: 'd', text: 'Ship Friday', quote: 'Ship Friday.', speaker: 0, atSeconds: 12 }],
  tasks: [
    {
      id: 't',
      text: 'Prepare release',
      quote: 'I will prepare it.',
      speaker: 0,
      atSeconds: 15,
      state: 'proposed' as const,
      taskId: null,
    },
  ],
  openQuestions: [
    { id: 'q', text: 'Which region?', quote: 'Which region?', speaker: 0, atSeconds: 20 },
  ],
  model: 'm',
  createdAt: 1,
  updatedAt: 1,
};
const props = {
  meeting: {
    id: 'm',
    sessionId: 's',
    engine: 'apple-speech' as const,
    startedAt: 0,
    endedAt: 60000,
    state: 'ended' as const,
    transcript: '',
    error: null,
    speakerNames: { '0': 'Anna' },
  },
  wide: true,
  people: 1,
  notes: null,
  speakers: null,
  answers: null,
  status: null,
  bottomInset: 0,
  onEditTitle: jest.fn(),
  onTranscript: jest.fn(),
  onShare: jest.fn(),
  onContinue: jest.fn(),
  onDone: jest.fn(),
  onResearch: jest.fn(),
};
const client = {
  getLiveMeetingResult: jest.fn(),
  updateLiveMeetingResultTask: jest.fn(),
  retryLiveMeetingResult: jest.fn(),
  getSession: jest.fn().mockResolvedValue({ projectId: 'p' }),
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getActiveMeetingServerId).mockReturnValue('original');
  client.getLiveMeetingResult.mockResolvedValue(ready);
  jest
    .mocked(createVerityClient)
    .mockReturnValue(client as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
});
it('shows ready content in iPad columns and sends explicit research and navigation actions', async () => {
  render(<MeetingResult {...props} />);
  expect(await screen.findByText(ready.summary)).toBeOnTheScreen();
  expect(screen.getByTestId('meeting-result-wide')).toBeOnTheScreen();
  expect(screen.getByText(/Anna ·.*I will prepare it/)).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Let Verity research'));
  expect(props.onResearch).toHaveBeenCalledWith('Which region?');
  fireEvent.press(screen.getByLabelText('Edit meeting title'));
  expect(props.onEditTitle).toHaveBeenCalled();
  fireEvent.press(screen.getByText('Transcript'));
  expect(props.onTranscript).toHaveBeenCalled();
});
it('keeps the working and failed states recoverable on phones', async () => {
  client.getLiveMeetingResult.mockResolvedValue({ ...ready, status: 'failed' });
  render(<MeetingResult {...props} wide={false} />);
  expect(await screen.findByText('Verity could not summarize this meeting.')).toBeOnTheScreen();
  expect(screen.getByTestId('meeting-result-stacked')).toBeOnTheScreen();
  client.retryLiveMeetingResult.mockResolvedValue(undefined);
  fireEvent.press(screen.getByText('Retry summary'));
  await waitFor(() => expect(client.retryLiveMeetingResult).toHaveBeenCalledWith('s', 'm'));
  expect(await screen.findByText('Verity is summarizing…')).toBeOnTheScreen();
});
it('confirms the proposal on the server before refreshing the task list', async () => {
  jest.mocked(refreshTasks).mockResolvedValue(undefined);
  client.updateLiveMeetingResultTask.mockResolvedValue({
    ...ready,
    tasks: [{ ...ready.tasks[0], state: 'added', taskId: 't' }],
  });
  render(<MeetingResult {...props} />);
  fireEvent.press(await screen.findByText('Add task'));
  expect(await screen.findByText('Added to tasks')).toBeOnTheScreen();
  expect(client.updateLiveMeetingResultTask).toHaveBeenCalledWith('s', 'm', 't', {
    revision: 1,
    state: 'added',
    taskId: 't',
  });
  expect(refreshTasks).toHaveBeenCalledWith(true);
});

it('dismisses a suggestion without creating a task', async () => {
  client.updateLiveMeetingResultTask.mockResolvedValue({
    ...ready,
    tasks: [{ ...ready.tasks[0], state: 'dismissed' }],
  });
  render(<MeetingResult {...props} />);
  fireEvent.press(await screen.findByText('Not a task'));
  await waitFor(() =>
    expect(client.updateLiveMeetingResultTask).toHaveBeenCalledWith('s', 'm', 't', {
      revision: 1,
      state: 'dismissed',
    }),
  );
  expect(refreshTasks).not.toHaveBeenCalled();
  expect(screen.queryByText('Prepare release')).toBeNull();
  expect(screen.queryByText('TASKS')).toBeNull();
});

it('blocks retry after switching away from the meeting server', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  client.getLiveMeetingResult.mockResolvedValue({ ...ready, status: 'failed' });
  render(<MeetingResult {...props} meeting={{ ...props.meeting, serverId: 'original' }} />);
  await screen.findByText('Retry summary');
  jest.mocked(getActiveMeetingServerId).mockReturnValue('other');
  fireEvent.press(screen.getByText('Retry summary'));
  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith('Could not save', 'Reconnect to this meeting’s server.'),
  );
  expect(client.retryLiveMeetingResult).not.toHaveBeenCalled();
  alert.mockRestore();
});
