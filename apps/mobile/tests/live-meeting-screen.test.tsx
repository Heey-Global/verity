import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { FlatList } from 'react-native';

import MeetingScreen from '../app/meeting/[sessionId]';
import { createVerityClient, getActiveMeetingServerId } from '../lib/client';
import {
  currentMeeting,
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  startMeeting,
  subscribeMeeting,
} from '../lib/liveMeetingSession';
import {
  listMeetings,
  listNotes,
  saveNote,
  type MeetingNote,
  type MeetingRecord,
} from '../lib/liveMeetingStore';

jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ sessionId: 'session-1' }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('../lib/liveMeetingSTT', () => ({
  liveMeetingSTT: {
    engines: jest
      .fn()
      .mockResolvedValue([{ id: 'fluid-nemotron', name: 'Nemotron', available: true }]),
  },
}));
jest.mock('../lib/liveMeetingSession', () => ({
  currentMeeting: jest.fn().mockReturnValue(null),
  subscribeMeeting: jest.fn().mockImplementation((listener) => {
    listener(null);
    return jest.fn();
  }),
  startMeeting: jest.fn().mockResolvedValue({
    id: 'meeting-1',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  }),
  endMeeting: jest.fn(),
  pauseMeeting: jest.fn().mockResolvedValue(undefined),
  resumeMeeting: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/liveMeetingStore', () => ({
  listMeetings: jest.fn().mockResolvedValue([]),
  listNotes: jest.fn().mockResolvedValue([]),
  loadDraftNote: jest.fn().mockResolvedValue(null),
  saveNote: jest.fn().mockResolvedValue(undefined),
  finalizeNote: jest.fn().mockResolvedValue(true),
}));
jest.mock('../lib/liveMeetingSync', () => ({
  syncMeetingSession: jest.fn().mockResolvedValue({ pending: false }),
  followRemoteMeeting: jest.fn(),
}));
jest.mock('../lib/client', () => ({
  createVerityClient: jest.fn().mockReturnValue(null),
  getActiveMeetingServerId: jest.fn().mockReturnValue(null),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(currentMeeting).mockReturnValue(null);
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    listener(null);
    return jest.fn();
  });
  jest.mocked(endMeeting).mockResolvedValue(undefined);
  jest.mocked(listMeetings).mockResolvedValue([]);
  jest.mocked(listNotes).mockResolvedValue([]);
  jest.mocked(saveNote).mockResolvedValue(undefined);
  jest.mocked(createVerityClient).mockReturnValue(null);
  jest.mocked(getActiveMeetingServerId).mockReturnValue(null);
});

it.each([
  ['Pause', 'pause'],
  ['End meeting', 'stop'],
] as const)(
  'sends %s to the recording device and waits for confirmation',
  async (button, action) => {
    const remote: MeetingRecord = {
      id: 'remote-meeting',
      sessionId: 'session-1',
      serverId: 'server-1',
      engine: 'fluid-nemotron',
      startedAt: Date.now(),
      endedAt: null,
      state: 'active',
      captureStatus: 'listening',
      transcript: 'Remote words',
      error: null,
    };
    const requestLiveMeetingCommand = jest.fn().mockResolvedValue('command-1');
    jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
    jest.mocked(createVerityClient).mockReturnValue({
      getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
      requestLiveMeetingCommand,
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    jest.mocked(listMeetings).mockResolvedValue([remote]);
    render(<MeetingScreen />);
    fireEvent.press(await screen.findByText(new RegExp(button)));
    await waitFor(() =>
      expect(requestLiveMeetingCommand).toHaveBeenCalledWith('session-1', remote.id, action),
    );
    expect(
      screen.getByText(new RegExp(`Waiting for recording device to ${action}`)),
    ).toBeOnTheScreen();
  },
);

it('explains an unreachable recorder and still lets Stop replace a pending Pause', async () => {
  const remote: MeetingRecord = {
    id: 'remote-meeting',
    sessionId: 'session-1',
    serverId: 'server-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: '',
    error: null,
  };
  const requestLiveMeetingCommand = jest.fn().mockResolvedValue('stop-1');
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
  jest.mocked(createVerityClient).mockReturnValue({
    getLiveMeetingCommands: jest.fn().mockResolvedValue({
      commands: [
        {
          id: 'pause-1',
          meetingId: remote.id,
          action: 'pause',
          state: 'pending',
          error: null,
          requestedAt: 1,
          acknowledgedAt: null,
        },
      ],
      recorderOnline: false,
    }),
    requestLiveMeetingCommand,
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  jest.mocked(listMeetings).mockResolvedValue([remote]);
  render(<MeetingScreen />);
  await screen.findByText(/Recording device unreachable/);
  fireEvent.press(screen.getByText('End meeting'));
  await waitFor(() =>
    expect(requestLiveMeetingCommand).toHaveBeenCalledWith('session-1', remote.id, 'stop'),
  );
});

it('starts with Nemotron and saves a note at its first edit', async () => {
  jest.mocked(currentMeeting).mockImplementation(() =>
    jest.mocked(startMeeting).mock.calls.length > 0
      ? {
          id: 'meeting-1',
          sessionId: 'session-1',
          engine: 'fluid-nemotron',
          startedAt: Date.now(),
          endedAt: null,
          state: 'active',
          transcript: '',
          error: null,
        }
      : null,
  );
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByText('Start meeting'));
  await waitFor(() => expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron'));
  const input = await screen.findByLabelText('Add a meeting note');
  fireEvent.changeText(input, 'Decision: ship locally');
  await waitFor(() =>
    expect(saveNote).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: 'meeting-1',
        text: 'Decision: ship locally',
      }),
    ),
  );
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Add note'));
  });
});

it('updates a mounted meeting screen when another instance edits a note', async () => {
  const live: MeetingRecord = {
    id: 'meeting-shared',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([live]);
  jest.mocked(currentMeeting).mockReturnValue(live);

  render(
    <>
      <MeetingScreen />
      <MeetingScreen />
    </>,
  );
  await waitFor(() => expect(screen.getAllByLabelText('Add a meeting note')).toHaveLength(2));
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.changeText(screen.getAllByLabelText('Add a meeting note')[1], 'Shared decision');

  await act(async () => {
    fireEvent.press(screen.getAllByLabelText('Add note')[1]);
  });
  await waitFor(() => expect(screen.getAllByTestId('meeting-note')).toHaveLength(2));
});

it('shows an unsaved note and offers a retry after its write fails', async () => {
  const live: MeetingRecord = {
    id: 'meeting-2',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  jest.mocked(startMeeting).mockResolvedValueOnce(live);
  let notify!: (meeting: MeetingRecord | null) => void;
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    notify = listener;
    listener(null);
    return jest.fn();
  });
  jest.mocked(endMeeting).mockImplementation(async () => {
    live.state = 'ended';
    live.endedAt = Date.now();
    notify({ ...live });
  });
  jest
    .mocked(currentMeeting)
    .mockImplementation(() => (jest.mocked(startMeeting).mock.calls.length > 0 ? live : null));
  jest.mocked(saveNote).mockRejectedValueOnce(new Error('disk full'));

  render(<MeetingScreen />);
  fireEvent.press(await screen.findByText('Start meeting'));
  fireEvent.changeText(await screen.findByLabelText('Add a meeting note'), 'Unsaved decision');
  await screen.findByText('● Recording · note not saved');
  expect(screen.getByLabelText('Retry saving note')).toBeOnTheScreen();

  fireEvent.press(screen.getByText('End meeting'));
  await screen.findByText('Ended · note not saved');
  expect(screen.queryByText('Engine for next meeting')).toBeNull();
  fireEvent.press(screen.getByText('Start another meeting'));
  expect(screen.getByText('Engine for next meeting')).toBeOnTheScreen();

  fireEvent.press(screen.getByLabelText('Retry saving note'));
  await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
  await screen.findByText('Ended · server sync pending');
  expect(screen.getByText(/Unsaved decision/)).toBeOnTheScreen();
});

it('shows an autosaved draft after the meeting ends before Add note', async () => {
  const live: MeetingRecord = {
    id: 'meeting-autosaved',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  let notify!: (meeting: MeetingRecord | null) => void;
  jest.mocked(currentMeeting).mockReturnValue(live);
  jest.mocked(listMeetings).mockResolvedValue([live]);
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    notify = listener;
    listener(live);
    return jest.fn();
  });
  jest.mocked(endMeeting).mockImplementation(async () => {
    live.state = 'ended';
    live.endedAt = Date.now();
    notify({ ...live });
  });

  render(<MeetingScreen />);
  fireEvent.changeText(await screen.findByLabelText('Add a meeting note'), 'Draft at the end');
  expect(screen.queryByTestId('meeting-note')).toBeNull();
  fireEvent.press(screen.getByText('End meeting'));
  expect((await screen.findByLabelText('Add a meeting note')).props.value).toBe('Draft at the end');
});

it('retries a failed save even when the edited draft contains only spaces', async () => {
  const live: MeetingRecord = {
    id: 'meeting-blank-retry',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  jest.mocked(currentMeeting).mockReturnValue(live);
  jest.mocked(listMeetings).mockResolvedValue([live]);
  jest.mocked(saveNote).mockRejectedValueOnce(new Error('disk full'));
  render(<MeetingScreen />);
  fireEvent.changeText(await screen.findByLabelText('Add a meeting note'), '   ');
  fireEvent.press(await screen.findByLabelText('Retry saving note'));
  await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
  await screen.findByText(/Transcribing/);
});

it('keeps a new note when an older notes read finishes afterward', async () => {
  const live: MeetingRecord = {
    id: 'meeting-3',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  let releaseNotes!: (notes: MeetingNote[]) => void;
  jest.mocked(listNotes).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseNotes = resolve;
      }),
  );
  jest.mocked(startMeeting).mockResolvedValueOnce(live);
  jest
    .mocked(currentMeeting)
    .mockImplementation(() => (jest.mocked(startMeeting).mock.calls.length > 0 ? live : null));

  render(<MeetingScreen />);
  fireEvent.press(await screen.findByText('Start meeting'));
  fireEvent.changeText(await screen.findByLabelText('Add a meeting note'), 'New note');
  expect(screen.queryByTestId('meeting-note')).toBeNull();
  await act(async () => {
    fireEvent(screen.getByLabelText('Add a meeting note'), 'submitEditing');
  });
  await screen.findByText(/New note/);
  await act(async () => {
    releaseNotes([]);
  });
  expect(screen.getByText(/New note/)).toBeOnTheScreen();
});

it('does not discard edits made while Done note awaits an earlier save', async () => {
  const live: MeetingRecord = {
    id: 'meeting-4',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  let releaseFirst!: () => void;
  jest.mocked(saveNote).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
  );
  jest.mocked(startMeeting).mockResolvedValueOnce(live);
  jest
    .mocked(currentMeeting)
    .mockImplementation(() => (jest.mocked(startMeeting).mock.calls.length > 0 ? live : null));

  const view = render(<MeetingScreen />);
  fireEvent.press(await screen.findByText('Start meeting'));
  const input = await screen.findByLabelText('Add a meeting note');
  fireEvent.changeText(input, 'First version');
  fireEvent.press(screen.getByLabelText('Add note'));
  fireEvent.changeText(input, 'Revised version');
  await act(async () => {
    releaseFirst();
  });

  expect(screen.getByLabelText('Add a meeting note')).toHaveDisplayValue('Revised version');
  expect(screen.getByLabelText('Add note')).toBeOnTheScreen();
  view.unmount();
  render(<MeetingScreen />);
  expect(await screen.findByLabelText('Add a meeting note')).toHaveDisplayValue('Revised version');
});

it('shows a late note-save failure after the meeting screen is reopened', async () => {
  const live: MeetingRecord = {
    id: 'meeting-6',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  let rejectSave!: (reason: Error) => void;
  jest.mocked(saveNote).mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  jest.mocked(startMeeting).mockResolvedValueOnce(live);
  jest
    .mocked(currentMeeting)
    .mockImplementation(() => (jest.mocked(startMeeting).mock.calls.length > 0 ? live : null));

  const first = render(<MeetingScreen />);
  fireEvent.press(await screen.findByText('Start meeting'));
  fireEvent.changeText(await screen.findByLabelText('Add a meeting note'), 'Keep this note');
  first.unmount();
  render(<MeetingScreen />);
  expect(await screen.findByLabelText('Add a meeting note')).toHaveDisplayValue('Keep this note');

  await act(async () => {
    rejectSave(new Error('disk full'));
  });
  expect(await screen.findByText('● Recording · note not saved')).toBeOnTheScreen();
  expect(screen.getByLabelText('Retry saving note')).toBeOnTheScreen();
});

it('keeps the retry draft when Done note is pressed after remount during a failed save', async () => {
  const live: MeetingRecord = {
    id: 'meeting-remount-save',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  let rejectSave!: (reason: Error) => void;
  jest.mocked(saveNote).mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  jest.mocked(startMeeting).mockResolvedValueOnce(live);
  jest
    .mocked(currentMeeting)
    .mockImplementation(() => (jest.mocked(startMeeting).mock.calls.length > 0 ? live : null));

  const first = render(<MeetingScreen />);
  fireEvent.press(await screen.findByText('Start meeting'));
  fireEvent.changeText(await screen.findByLabelText('Add a meeting note'), 'Recover me');
  first.unmount();
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Add note'));
  await act(async () => rejectSave(new Error('disk full')));

  expect(await screen.findByLabelText('Retry saving note')).toBeOnTheScreen();
  expect(screen.getByLabelText('Add a meeting note')).toHaveDisplayValue('Recover me');
});

it('keeps a historical transcript open while the live meeting updates', async () => {
  const live: MeetingRecord = {
    id: 'live',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: 'Live text',
    error: null,
  };
  const past: MeetingRecord = {
    ...live,
    id: 'past',
    startedAt: Date.now() - 3600000,
    endedAt: Date.now() - 3500000,
    state: 'ended',
    transcript: 'Historical transcript',
  };
  let resolveLiveNotes!: (notes: MeetingNote[]) => void;
  let resolvePastNotes!: (notes: MeetingNote[]) => void;
  const liveNotes = new Promise<MeetingNote[]>((resolve) => {
    resolveLiveNotes = resolve;
  });
  const pastNotes = new Promise<MeetingNote[]>((resolve) => {
    resolvePastNotes = resolve;
  });
  jest
    .mocked(listNotes)
    .mockImplementation((meetingId) => (meetingId === 'live' ? liveNotes : pastNotes));
  let notify!: (meeting: MeetingRecord | null) => void;
  jest.mocked(currentMeeting).mockReturnValue(live);
  jest.mocked(listMeetings).mockResolvedValue([live, past]);
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    notify = listener;
    listener(live);
    return jest.fn();
  });

  render(<MeetingScreen />);
  await waitFor(() => expect(listNotes).toHaveBeenCalledWith('live'));
  fireEvent.press(await screen.findByText(/ended/));
  await screen.findByText('Historical transcript');
  await waitFor(() => expect(listNotes).toHaveBeenCalledWith('past'));
  act(() =>
    resolvePastNotes([{ id: 'past-note', meetingId: 'past', atSeconds: 2, text: 'Past note' }]),
  );
  await screen.findByText(/Past note/);
  await act(async () => {
    resolveLiveNotes([{ id: 'live-note', meetingId: 'live', atSeconds: 2, text: 'Live note' }]);
  });
  act(() => notify({ ...live, transcript: 'New live words' }));
  expect(screen.getByText('Historical transcript')).toBeOnTheScreen();
  expect(screen.getByText(/Past note/)).toBeOnTheScreen();
  expect(screen.queryByText(/Live note/)).toBeNull();
  expect(screen.queryByText('New live words')).toBeNull();
});

it('follows new transcript text until the reader scrolls away', async () => {
  const live: MeetingRecord = {
    id: 'meeting-scroll',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: 'First words',
    error: null,
  };
  jest.mocked(currentMeeting).mockReturnValue(live);
  jest.mocked(listMeetings).mockResolvedValue([live]);
  const scrollToEnd = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => undefined);
  try {
    render(<MeetingScreen />);
    const transcript = await screen.findByTestId('meeting-transcript');
    fireEvent(transcript, 'contentSizeChange', 200, 600);
    expect(scrollToEnd).toHaveBeenCalled();
    scrollToEnd.mockClear();
    fireEvent(transcript, 'scrollBeginDrag');
    fireEvent(transcript, 'contentSizeChange', 200, 700);
    expect(scrollToEnd).not.toHaveBeenCalled();
  } finally {
    scrollToEnd.mockRestore();
  }
});

it('offers pause and resume on the full meeting screen', async () => {
  const live: MeetingRecord = {
    id: 'meeting-pause',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: '',
    error: null,
  };
  let notify!: (meeting: MeetingRecord | null) => void;
  jest.mocked(currentMeeting).mockReturnValue(live);
  jest.mocked(listMeetings).mockResolvedValue([live]);
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    notify = listener;
    listener(live);
    return jest.fn();
  });
  render(<MeetingScreen />);
  await act(async () => fireEvent.press(await screen.findByText('Ⅱ  Pause')));
  expect(pauseMeeting).toHaveBeenCalledTimes(1);
  act(() => notify({ ...live, captureStatus: 'paused' }));
  await act(async () => fireEvent.press(await screen.findByText('▶  Resume')));
  expect(resumeMeeting).toHaveBeenCalledTimes(1);
});
