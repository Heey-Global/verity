import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams } from 'expo-router';

import MeetingScreen from '../app/meeting/[sessionId]';
import { createVerityClient } from '../lib/client';
import { currentMeeting, subscribeMeeting } from '../lib/liveMeetingSession';
import { listMeetings, listNotes, type MeetingRecord } from '../lib/liveMeetingStore';

// The iPad layout: people and notes on the left, Verity's pane on the right.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 1180, height: 820, scale: 2, fontScale: 1 }),
}));
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: jest.fn(() => ({ sessionId: 'session-1' })),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('../lib/liveMeetingSTT', () => ({
  liveMeetingSTT: { engines: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../lib/liveMeetingSession', () => ({
  currentMeeting: jest.fn().mockReturnValue(null),
  subscribeMeeting: jest.fn(),
  subscribeVoiceMeetingRequest: jest.fn().mockReturnValue(jest.fn()),
  startMeeting: jest.fn(),
  endMeeting: jest.fn(),
  pauseMeeting: jest.fn(),
  resumeMeeting: jest.fn(),
  updateSpeakerEdits: jest.fn(),
  clearSpeakerNameSuggestion: jest.fn(),
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

const startedAt = new Date(2026, 9, 24, 17, 20, 0).getTime();
const meeting: MeetingRecord = {
  id: 'meeting-wide',
  sessionId: 'session-1',
  serverId: null,
  engine: 'fluid-nemotron',
  startedAt,
  endedAt: null,
  state: 'active',
  captureStatus: 'listening',
  transcript: 'How tall is the Eiffel Tower?',
  error: null,
};
const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function client() {
  const sendTurn = jest.fn().mockResolvedValue({ turnId: 'turn-1' });
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    getSession: jest.fn().mockResolvedValue({ model: 'claude-opus-5-5', projectId: 'project' }),
    listModels: jest.fn().mockResolvedValue({ models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }),
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getLiveMeetingInsights: jest.fn().mockResolvedValue([]),
    getSessionHistory: jest.fn().mockResolvedValue({ events: [], queued: [] }),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  return sendTurn;
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(currentMeeting).mockReturnValue(meeting);
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    listener(meeting);
    return jest.fn();
  });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest
    .mocked(listNotes)
    .mockResolvedValue([
      { id: 'note-1', meetingId: meeting.id, atSeconds: 90, text: 'Budget still open' },
    ]);
});

it('shows notes at the local time they were written and the transcript only when switched on', async () => {
  client();
  render(<MeetingScreen />);
  expect(await screen.findByTestId('verity-pane')).toBeOnTheScreen();
  expect(await screen.findByText('Budget still open')).toBeOnTheScreen();
  // The time of day the note was written, not minutes since the meeting started.
  expect(screen.getByText(clock(startedAt + 90_000))).toBeOnTheScreen();
  expect(screen.queryByTestId('meeting-transcript')).toBeNull();

  const transcript = screen.getByRole('switch', { name: 'Transcript' });
  expect(transcript.props.accessibilityState).toEqual({ checked: false });
  fireEvent.press(transcript);
  expect(screen.getByTestId('meeting-transcript')).toBeOnTheScreen();
  expect(screen.getByText(/How tall is the Eiffel Tower\?/)).toBeOnTheScreen();
  // The choice carries over to the next meeting.
  await waitFor(async () =>
    expect(JSON.parse((await AsyncStorage.getItem('verity.meeting.preferences'))!)).toEqual({
      transcript: true,
    }),
  );
  fireEvent.press(screen.getByRole('switch', { name: 'Transcript' }));
  expect(screen.queryByTestId('meeting-transcript')).toBeNull();
});

it('asks Verity with the model picked for this meeting instead of the faster default', async () => {
  const sendTurn = client();
  render(<MeetingScreen />);
  // Opus in the chat runs meeting answers on Sonnet until another model is picked here.
  const chip = await screen.findByLabelText(/^Model for meeting answers: Claude Sonnet 5\.5/);
  fireEvent.press(chip);
  fireEvent.press(await screen.findByLabelText('Use Claude Opus 5.5'));
  expect(
    await screen.findByLabelText(/^Model for meeting answers: Claude Opus 5\.5/),
  ).toBeOnTheScreen();

  fireEvent.changeText(screen.getByLabelText('Ask Verity about this meeting'), 'Ticket prices?');
  fireEvent.press(screen.getByLabelText('Ask Verity in meeting'));
  await waitFor(() =>
    expect(sendTurn).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ model: 'claude-opus-5-5' }),
    ),
  );
  // The request appears as Verity's card while it works.
  expect(await screen.findByText('Ticket prices?')).toBeOnTheScreen();
  expect(screen.getByText('Working on it…')).toBeOnTheScreen();
  expect(
    screen.getByTestId('meeting-card-working', { includeHiddenElements: true }),
  ).toBeOnTheScreen();
});
