import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import MeetingScreen from '../app/meeting/[sessionId]';
import {
  currentMeeting,
  endMeeting,
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
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
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
}));
jest.mock('../lib/liveMeetingStore', () => ({
  listMeetings: jest.fn().mockResolvedValue([]),
  listNotes: jest.fn().mockResolvedValue([]),
  saveNote: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => jest.clearAllMocks());

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
    fireEvent.press(screen.getByText('Done note'));
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
  expect(screen.getByText('Retry saving note')).toBeOnTheScreen();

  fireEvent.press(screen.getByText('End meeting'));
  await screen.findByText('Ended · note not saved');

  fireEvent.press(screen.getByText('Retry saving note'));
  await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
  await screen.findByText('Ended · saved locally');
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
  fireEvent.press(screen.getByText('Done note'));
  fireEvent.changeText(input, 'Revised version');
  await act(async () => {
    releaseFirst();
  });

  expect(screen.getByLabelText('Add a meeting note')).toHaveDisplayValue('Revised version');
  expect(screen.getByText('Done note')).toBeOnTheScreen();
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
  expect(screen.getByText('Retry saving note')).toBeOnTheScreen();
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
  fireEvent.press(await screen.findByText('Done note'));
  await act(async () => rejectSave(new Error('disk full')));

  expect(await screen.findByText('Retry saving note')).toBeOnTheScreen();
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
  jest
    .mocked(listNotes)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLiveNotes = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePastNotes = resolve;
        }),
    );
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
