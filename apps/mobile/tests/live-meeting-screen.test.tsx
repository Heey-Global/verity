import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, FlatList } from 'react-native';
import { router } from 'expo-router';

import MeetingScreen from '../app/meeting/[sessionId]';
import { createVerityClient, getActiveMeetingServerId } from '../lib/client';
import {
  currentMeeting,
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  startMeeting,
  subscribeMeeting,
  subscribeVoiceMeetingRequest,
  updateSpeakerEdits,
} from '../lib/liveMeetingSession';
import {
  listMeetings,
  listNotes,
  finalizeNote,
  saveNote,
  type MeetingNote,
  type MeetingRecord,
} from '../lib/liveMeetingStore';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
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
  subscribeVoiceMeetingRequest: jest.fn().mockReturnValue(jest.fn()),
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
  updateSpeakerEdits: jest.fn().mockResolvedValue(undefined),
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

// The phone layout keeps the note field behind the Note button until a note is being written.
async function noteInput() {
  const target = await screen.findByLabelText(/^(Write a note|Add a meeting note)$/);
  if (target.props.accessibilityLabel === 'Write a note') fireEvent.press(target);
  return screen.getByLabelText('Add a meeting note');
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(subscribeVoiceMeetingRequest).mockReturnValue(jest.fn());
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

it('passes the selected expected group size when starting a meeting', async () => {
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Up to 4 people'));
  expect(screen.getByLabelText('Up to 4 people').props.accessibilityState).toEqual(
    expect.objectContaining({ selected: true }),
  );
  fireEvent.press(screen.getByLabelText('Start meeting'));
  await waitFor(() => expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', 4));
});

it('offers larger groups and passes their size to the recorder', async () => {
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Larger group'));
  fireEvent.press(screen.getByLabelText('Start meeting'));
  await waitFor(() => expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', 10));
});

it('shows a listening state before speech and numbered voices as they are recognized', async () => {
  const meeting: MeetingRecord = {
    id: 'speaker-meeting',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
    speakerStatus: 'ready',
    speakerTurns: [],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(currentMeeting).mockReturnValue(meeting);
  let publish!: (meeting: MeetingRecord | null) => void;
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    publish = listener;
    listener(meeting);
    return jest.fn();
  });
  render(<MeetingScreen />);
  expect(await screen.findByText('Listening for voices…')).toBeOnTheScreen();
  act(() =>
    publish({
      ...meeting,
      speakerTurns: [
        { speaker: 2, start: 1, end: 2 },
        { speaker: 0, start: 3, end: 4 },
      ],
    }),
  );
  expect(screen.getByLabelText('Rename Speaker 1')).toBeOnTheScreen();
  expect(screen.getByLabelText('Rename Speaker 3')).toBeOnTheScreen();
});

it('keeps research and fact checks in the meeting while sending turns to its session', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-insight',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'The delivery plan changed. Is the release still Friday?',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  const sendTurn = jest.fn().mockResolvedValue({ turnId: 'turn-1' });
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getLiveMeetingInsights: jest.fn().mockResolvedValue([
      {
        id: 'insight-1',
        meetingId: meeting.id,
        kind: 'contradiction',
        summary: 'The delivery dates differ.',
        evidenceA: 'Tuesday',
        evidenceB: 'Friday',
        sourcePath: 'insights/plan.md',
        createdAt: 1,
      },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  expect(await screen.findByText('Is the release still Friday?')).toBeOnTheScreen();
  expect(await screen.findByText('The delivery dates differ.')).toBeOnTheScreen();
  expect(screen.getByText('Source: insights/plan.md')).toBeOnTheScreen();
  expect(screen.queryByTestId('meeting-transcript')).toBeNull();
  fireEvent.press(screen.getByLabelText('Open full transcript'));
  expect(screen.getByTestId('meeting-transcript')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Research meeting question'));
  await waitFor(() => {
    expect(sendTurn).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ prompt: expect.stringContaining('Is the release still Friday?') }),
    );
    expect(screen.getByText('VERITY IS WORKING')).toBeOnTheScreen();
  });
  expect(router.push).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Check meeting claim'));
  await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
  expect(sendTurn.mock.calls[1]?.[1].prompt).toContain(
    'Check whether “Tuesday” conflicts with “Friday”',
  );
  expect(router.push).not.toHaveBeenCalled();
});

it('shows the compact session answer in the meeting after reopening it', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-answer',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: 'Is Friday correct?',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(createVerityClient).mockReturnValue({
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getHistory: jest.fn().mockImplementation(async (_sessionId, options) =>
      options?.beforeSeq
        ? {
            hasMore: false,
            events: [
              {
                seq: 7,
                event: {
                  t: 'prompt',
                  text: 'Research this point raised during live meeting meeting-answer:\n\nIs Friday correct?\n\nRecent meeting transcript:\nIs Friday correct?',
                },
              },
            ],
          }
        : {
            hasMore: true,
            events: [
              { seq: 8, event: { t: 'text', delta: 'The roadmap confirms Tuesday.' } },
              { seq: 9, event: { t: 'result' } },
            ],
          },
    ),
    getActivity: jest.fn().mockResolvedValue({
      busy: true,
      queued: [
        {
          id: 'waiting-1',
          text: 'During live meeting meeting-answer, please respond to this request:\n\nWhat changed?',
        },
      ],
    }),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  expect(await screen.findByText('ANSWER READY')).toBeOnTheScreen();
  expect(screen.getByText('The roadmap confirms Tuesday.')).toBeOnTheScreen();
  expect(screen.getByText('What changed?')).toBeOnTheScreen();
  expect(router.push).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Open answer in chat'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/session/[id]',
    params: { id: 'session-1' },
  });
});

it('shows a spoken request as working without leaving the meeting', async () => {
  let notify!: (event: {
    meetingId: string;
    sessionId: string;
    status: 'sent';
    request: string;
    kind: 'research';
  }) => void;
  jest.mocked(subscribeVoiceMeetingRequest).mockImplementation((listener) => {
    notify = listener;
    return jest.fn();
  });
  const meeting: MeetingRecord = {
    id: 'meeting-voice-answer',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: 'Verity, check the deadline.',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  await screen.findByLabelText('Open full transcript');
  act(() =>
    notify({
      meetingId: meeting.id,
      sessionId: meeting.sessionId,
      status: 'sent',
      request: 'check the deadline',
      kind: 'research',
    }),
  );
  expect(screen.getByText('check the deadline')).toBeOnTheScreen();
  expect(screen.getByText('VERITY IS WORKING')).toBeOnTheScreen();
  expect(router.push).not.toHaveBeenCalled();
});

it('shows timed transcript words with their speaker when attribution is unambiguous', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-speakers',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'Hello yes',
    error: null,
    speakerTurns: [{ speaker: 0, start: 0, end: 1 }],
    timedWords: [
      { text: 'Hello', start: 0.1, end: 0.5 },
      { text: 'yes', start: 2, end: 2.4 },
    ],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(currentMeeting).mockReturnValue(meeting);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  expect(screen.getByText('Speaker 1: Hello')).toBeOnTheScreen();
  expect(screen.getByText('Unknown speaker: yes')).toBeOnTheScreen();
});

it('keeps the unfinished transcript visible after timed words', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-tail',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'Hello, from the meeting',
    error: null,
    speakerTurns: [{ speaker: 0, start: 0, end: 0.6 }],
    timedWords: [{ text: 'Hello', start: 0, end: 0.4 }],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  expect(screen.getByText('Speaker 1: Hello,')).toBeOnTheScreen();
  expect(screen.getByText('Speaker pending: from the meeting')).toBeOnTheScreen();
});

it('shows the transcript once when its text no longer matches the timed words', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-revised',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'Revised meeting text',
    error: null,
    speakerTurns: [{ speaker: 0, start: 0, end: 0.6 }],
    timedWords: [{ text: 'Old', start: 0, end: 0.4 }],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  expect(screen.getByText('Revised meeting text')).toBeOnTheScreen();
  expect(screen.queryByText('Speaker 1: Old')).not.toBeOnTheScreen();
});

it('saves a correction for one speaker segment without changing the other', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const meeting: MeetingRecord = {
    id: 'meeting-correction',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'ended',
    transcript: 'Hello there',
    error: null,
    ownerToken: 'owner',
    speakerTurns: [
      { speaker: 0, start: 0, end: 0.5 },
      { speaker: 1, start: 1, end: 1.5 },
    ],
    timedWords: [
      { text: 'Hello', start: 0, end: 0.5 },
      { text: 'there', start: 1, end: 1.5 },
    ],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  fireEvent.press(screen.getByLabelText('Correct speaker for Hello'));
  const buttons = alert.mock.calls.at(-1)?.[2] ?? [];
  act(() => buttons.find((button) => button.text === 'Speaker 2')?.onPress?.());
  await waitFor(() =>
    expect(updateSpeakerEdits).toHaveBeenCalledWith(
      meeting.id,
      {},
      [{ start: 0, end: 0.5, speaker: 1 }],
      {},
    ),
  );
  alert.mockRestore();
});

it('renames a speaker across the current meeting', async () => {
  const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => undefined);
  const meeting: MeetingRecord = {
    id: 'meeting-name',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'ended',
    transcript: 'Hello',
    error: null,
    ownerToken: 'owner',
    speakerTurns: [{ speaker: 0, start: 0, end: 1 }],
    timedWords: [{ text: 'Hello', start: 0, end: 0.5 }],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  await screen.findByLabelText('Rename Speaker 1');
  fireEvent.press(screen.getByLabelText('Rename Speaker 1'));
  const reply = prompt.mock.calls.at(-1)?.[2];
  if (typeof reply === 'function') act(() => reply('Anna'));
  await waitFor(() =>
    expect(updateSpeakerEdits).toHaveBeenCalledWith(meeting.id, { '0': 'Anna' }, [], {}),
  );
  fireEvent.press(screen.getByLabelText('Open full transcript'));
  expect(screen.getByText('Anna: Hello')).toBeOnTheScreen();
  prompt.mockRestore();
});

it('keeps a rename when a correction is made before its save finishes', async () => {
  const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => undefined);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  let finishFirstSave!: () => void;
  jest
    .mocked(updateSpeakerEdits)
    .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirstSave = resolve)));
  const meeting: MeetingRecord = {
    id: 'meeting-quick-edits',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'ended',
    transcript: 'Hello',
    error: null,
    ownerToken: 'owner',
    speakerTurns: [{ speaker: 0, start: 0, end: 1 }],
    timedWords: [{ text: 'Hello', start: 0, end: 0.5 }],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  await screen.findByLabelText('Rename Speaker 1');
  fireEvent.press(screen.getByLabelText('Rename Speaker 1'));
  const reply = prompt.mock.calls.at(-1)?.[2];
  if (typeof reply === 'function') act(() => reply('Anna'));
  await waitFor(() => expect(updateSpeakerEdits).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByLabelText('Open full transcript'));
  fireEvent.press(screen.getByLabelText('Correct speaker for Hello'));
  const buttons = alert.mock.calls.at(-1)?.[2] ?? [];
  act(() => buttons.find((button) => button.text === 'Unknown speaker')?.onPress?.());
  expect(updateSpeakerEdits).toHaveBeenCalledTimes(1);
  await act(async () => finishFirstSave());
  await waitFor(() =>
    expect(updateSpeakerEdits).toHaveBeenLastCalledWith(
      meeting.id,
      { '0': 'Anna' },
      [{ start: 0, end: 0.5, speaker: null }],
      {},
    ),
  );
  prompt.mockRestore();
  alert.mockRestore();
});

it('rejects a speaker name longer than the sync contract allows', async () => {
  const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => undefined);
  const meeting: MeetingRecord = {
    id: 'meeting-long-name',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'ended',
    transcript: 'Hello',
    error: null,
    ownerToken: 'owner',
    speakerTurns: [{ speaker: 0, start: 0, end: 1 }],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  await screen.findByLabelText('Rename Speaker 1');
  fireEvent.press(screen.getByLabelText('Rename Speaker 1'));
  const reply = prompt.mock.calls.at(-1)?.[2];
  if (typeof reply === 'function') act(() => reply('A'.repeat(61)));
  expect(screen.getByText('Speaker names can be at most 60 characters.')).toBeOnTheScreen();
  expect(updateSpeakerEdits).not.toHaveBeenCalled();
  prompt.mockRestore();
});

it('offers the expected speaker slots when no diarizer turn was detected', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const meeting: MeetingRecord = {
    id: 'meeting-unknown',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'ended',
    transcript: 'Hello',
    error: null,
    ownerToken: 'owner',
    expectedParticipants: 2,
    speakerTurns: [],
    timedWords: [{ text: 'Hello', start: 0, end: 0.5 }],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  fireEvent.press(screen.getByLabelText('Correct speaker for Hello'));
  expect(alert.mock.calls.at(-1)?.[2]?.map((button) => button.text)).toContain('Speaker 2');
  alert.mockRestore();
});

it('merges duplicate speaker labels and allows undo', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const meeting: MeetingRecord = {
    id: 'meeting-merge',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'ended',
    transcript: 'One Two',
    error: null,
    ownerToken: 'owner',
    expectedParticipants: 2,
    speakerTurns: [
      { speaker: 0, start: 0, end: 0.5 },
      { speaker: 1, start: 1, end: 1.5 },
    ],
    timedWords: [
      { text: 'One', start: 0, end: 0.5 },
      { text: 'Two', start: 1, end: 1.5 },
    ],
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  expect(await screen.findByLabelText('Rename Speaker 2')).toBeOnTheScreen();
  fireEvent(screen.getByLabelText('Rename Speaker 2'), 'longPress');
  const buttons = alert.mock.calls.at(-1)?.[2] ?? [];
  act(() => buttons.find((button) => button.text === 'Speaker 1')?.onPress?.());
  await waitFor(() =>
    expect(updateSpeakerEdits).toHaveBeenCalledWith(meeting.id, {}, [], { '1': 0 }),
  );
  expect(screen.queryByLabelText('Rename Speaker 2')).toBeNull();
  fireEvent.press(screen.getByLabelText('Restore merged speaker'));
  const restoreButtons = alert.mock.calls.at(-1)?.[2] ?? [];
  act(() => restoreButtons.find((button) => button.text === 'Speaker 2')?.onPress?.());
  await waitFor(() => expect(updateSpeakerEdits).toHaveBeenLastCalledWith(meeting.id, {}, [], {}));
  alert.mockRestore();
});

it('shows a spoken request failure without interrupting the meeting', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-voice',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'Verity, research the deadline.',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  let notify!: (event: {
    meetingId: string;
    sessionId: string;
    status: 'failed';
    message: string;
  }) => void;
  jest.mocked(subscribeVoiceMeetingRequest).mockImplementation((listener) => {
    notify = listener;
    return jest.fn();
  });
  render(<MeetingScreen />);
  expect(await screen.findByText(/● Transcribing/)).toBeOnTheScreen();
  act(() =>
    notify({
      meetingId: meeting.id,
      sessionId: meeting.sessionId,
      status: 'failed',
      message: 'Voice request could not be sent: offline',
    }),
  );
  expect(screen.getByText('Voice request could not be sent: offline')).toBeOnTheScreen();
  expect(screen.getByText(/● Transcribing/)).toBeOnTheScreen();
});

it('starts a direct meeting request and stays put when the server rejects it', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-direct',
    sessionId: 'session-1',
    serverId: 'server-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'We need to decide today.',
    error: null,
  };
  const sendTurn = jest.fn().mockRejectedValue(new Error('offline'));
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Ask Verity'));
  const input = screen.getByLabelText('Ask Verity about this meeting');
  fireEvent.changeText(input, 'What do you think?');
  fireEvent.press(screen.getByLabelText('Ask Verity in meeting'));
  await waitFor(() =>
    expect(screen.getByText(/Could not start meeting request/)).toBeOnTheScreen(),
  );
  expect(sendTurn).toHaveBeenCalledWith(
    'session-1',
    expect.objectContaining({ prompt: expect.stringContaining('What do you think?') }),
  );
  expect(router.push).not.toHaveBeenCalled();
  expect(input).toHaveDisplayValue('What do you think?');
});

it.each([
  ['Pause meeting', 'pause'],
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
    fireEvent.press(await screen.findByLabelText(button));
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
  fireEvent.press(screen.getByLabelText('End meeting'));
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
  fireEvent.press(await screen.findByLabelText('Start meeting'));
  await waitFor(() =>
    expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', null),
  );
  const input = await noteInput();
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

it('keeps fast keystrokes before a re-render in one note', async () => {
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
  fireEvent.press(await screen.findByLabelText('Start meeting'));
  await waitFor(() => expect(startMeeting).toHaveBeenCalled());
  const input = await noteInput();
  // A hardware keyboard can deliver both changes before the screen renders the first one.
  act(() => {
    input.props.onChangeText('k');
    input.props.onChangeText('kl');
  });
  const ids = jest.mocked(saveNote).mock.calls.map(([note]) => note.id);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(screen.getAllByLabelText('Add a meeting note')[0]).toHaveDisplayValue('kl');

  // Once saved, the module draft must be gone, or the next note would overwrite this one.
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Add note'));
  });
  await waitFor(() => expect(finalizeNote).toHaveBeenCalledWith(ids[0], 'kl'));
  await waitFor(() =>
    expect(screen.getAllByLabelText('Add a meeting note')[0]).toHaveDisplayValue(''),
  );
  act(() => screen.getAllByLabelText('Add a meeting note')[0]!.props.onChangeText('n'));
  expect(jest.mocked(saveNote).mock.calls.at(-1)![0].id).not.toBe(ids[0]);
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
  for (const button of await screen.findAllByLabelText('Write a note')) fireEvent.press(button);
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
  fireEvent.press(await screen.findByLabelText('Start meeting'));
  fireEvent.changeText(await noteInput(), 'Unsaved decision');
  await screen.findByText('● Recording · note not saved');
  expect(screen.getByLabelText('Retry saving note')).toBeOnTheScreen();

  fireEvent.press(screen.getByLabelText('End meeting'));
  await screen.findByText('Ended · note not saved');
  expect(screen.queryByLabelText('Speech recognition')).toBeNull();
  fireEvent.press(screen.getByText('Start another meeting'));
  // The start controls used to stack under the ended meeting and push Start off-screen.
  expect(screen.getByLabelText('Speech recognition')).toBeOnTheScreen();
  expect(screen.getByLabelText('Start meeting')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Open full transcript')).toBeNull();
  expect(screen.queryByLabelText('Retry saving note')).toBeNull();
  fireEvent.press(screen.getByText('Cancel'));

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
  fireEvent.changeText(await noteInput(), 'Draft at the end');
  expect(screen.queryByTestId('meeting-note')).toBeNull();
  fireEvent.press(screen.getByLabelText('End meeting'));
  await screen.findByText('Start another meeting');
  expect((await noteInput()).props.value).toBe('Draft at the end');
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
  fireEvent.changeText(await noteInput(), '   ');
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
  fireEvent.press(await screen.findByLabelText('Start meeting'));
  fireEvent.changeText(await noteInput(), 'New note');
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
  fireEvent.press(await screen.findByLabelText('Start meeting'));
  const input = await noteInput();
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
  expect(await noteInput()).toHaveDisplayValue('Revised version');
});

it('keeps a newer draft when finalizing an earlier version completes late', async () => {
  const live: MeetingRecord = {
    id: 'meeting-finalize-race',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  let releaseFinalize!: () => void;
  jest.mocked(finalizeNote).mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        releaseFinalize = () => resolve(true);
      }),
  );
  jest.mocked(currentMeeting).mockReturnValue(live);
  jest.mocked(listMeetings).mockResolvedValue([live]);
  render(<MeetingScreen />);
  const input = await noteInput();
  fireEvent.changeText(input, 'First version');
  fireEvent.press(screen.getByLabelText('Add note'));
  await waitFor(() => expect(finalizeNote).toHaveBeenCalledTimes(1));
  fireEvent.changeText(input, 'Revised version');
  await act(async () => releaseFinalize());
  expect(input).toHaveDisplayValue('Revised version');
  fireEvent.press(screen.getByLabelText('Add note'));
  await waitFor(() => expect(finalizeNote).toHaveBeenCalledTimes(2));
  expect(jest.mocked(finalizeNote).mock.calls[1]?.[1]).toBe('Revised version');
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
  fireEvent.press(await screen.findByLabelText('Start meeting'));
  fireEvent.changeText(await noteInput(), 'Keep this note');
  first.unmount();
  render(<MeetingScreen />);
  expect(await noteInput()).toHaveDisplayValue('Keep this note');

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
  fireEvent.press(await screen.findByLabelText('Start meeting'));
  fireEvent.changeText(await noteInput(), 'Recover me');
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
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
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
    fireEvent.press(await screen.findByLabelText('Open full transcript'));
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
  await act(async () => fireEvent.press(await screen.findByLabelText('Pause meeting')));
  expect(pauseMeeting).toHaveBeenCalledTimes(1);
  act(() => notify({ ...live, captureStatus: 'paused' }));
  await act(async () => fireEvent.press(await screen.findByLabelText('Resume meeting')));
  expect(resumeMeeting).toHaveBeenCalledTimes(1);
});

it('stamps notes with the time of day rather than the meeting timer', async () => {
  // A 90-second-old note in a meeting that started at 14:02 must read 14:03, not 01:30.
  const startedAt = new Date(2026, 8, 29, 14, 2, 0).getTime();
  const meeting: MeetingRecord = {
    id: 'meeting-clock',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt,
    endedAt: startedAt + 600_000,
    state: 'ended',
    transcript: '',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest
    .mocked(listNotes)
    .mockResolvedValue([{ id: 'n', meetingId: meeting.id, atSeconds: 90, text: 'Budget' }]);
  render(<MeetingScreen />);
  const expected = new Date(startedAt + 90_000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  expect(await screen.findByTestId('meeting-note')).toHaveTextContent(`${expected} Budget`);
  expect(expected).not.toBe('01:30');
});

it('saves a noticed point as a note and hides a dismissed question', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-noticed',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'Is the release still Friday?',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn: jest.fn(),
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getLiveMeetingInsights: jest.fn().mockResolvedValue([
      {
        id: 'insight-note',
        meetingId: meeting.id,
        kind: 'contradiction',
        summary: 'The delivery dates differ.',
        evidenceA: 'Tuesday',
        evidenceB: 'Friday',
        sourcePath: null,
        createdAt: 1,
      },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Save as note'));
  await waitFor(() =>
    expect(saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: meeting.id, text: 'The delivery dates differ.' }),
    ),
  );
  await waitFor(() => expect(finalizeNote).toHaveBeenCalled());
  expect(await screen.findByTestId('meeting-note')).toHaveTextContent(
    /The delivery dates differ\./,
  );

  expect(screen.getByText('Is the release still Friday?')).toBeOnTheScreen();
  // The open question is the last card, after the insight it did not come from.
  fireEvent.press(screen.getAllByText('Not now').at(-1)!);
  expect(screen.queryByText('Is the release still Friday?')).toBeNull();
});

it('does not show a noticed-point note whose save failed', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-noticed-failure',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: '',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(saveNote).mockRejectedValueOnce(new Error('disk full'));
  jest.mocked(createVerityClient).mockReturnValue({
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getLiveMeetingInsights: jest.fn().mockResolvedValue([
      {
        id: 'insight-failure',
        meetingId: meeting.id,
        kind: 'research',
        summary: 'Check the budget.',
        evidenceA: 'budget',
        evidenceB: null,
        sourcePath: null,
        createdAt: 1,
      },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Save as note'));
  expect(await screen.findByText('Note could not be saved: Error: disk full')).toBeOnTheScreen();
  expect(screen.queryByTestId('meeting-note')).toBeNull();
  expect(finalizeNote).not.toHaveBeenCalled();
  expect(screen.queryByText(/note not saved/)).toBeNull();
});
