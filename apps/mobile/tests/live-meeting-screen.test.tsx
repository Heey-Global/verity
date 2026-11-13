import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { VerityApiError } from '@verity/mobile';
import { Alert, FlatList } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { KEYBOARD_BOTTOM_OFFSET } from '../lib/keyboardOffsets';

import MeetingScreen from '../app/meeting/[sessionId]';
import {
  discardFinishedMeeting,
  finalizeMeetingOnServer,
  getMeetingSyncFailure,
  retryMeetingSync,
} from '../lib/liveMeetingSync';
import { createVerityClient, getActiveMeetingServerId } from '../lib/client';
import {
  clearSpeakerNameSuggestion,
  currentMeeting,
  endMeeting,
  recoverMeetingAudio,
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
  loadDraftNote,
  finalizeNote,
  saveNote,
  updateNote,
  updateMeetingTitle,
  type MeetingNote,
  type MeetingRecord,
} from '../lib/liveMeetingStore';
import { liveMeetingSTT } from '../lib/liveMeetingSTT';

// Keep a distinct component identity so a plain ScrollView cannot pass the keyboard guard.
jest.mock('react-native-keyboard-controller', () => ({
  ...require('react-native-keyboard-controller/jest'),
  KeyboardAwareScrollView: (props: object) =>
    require('react').createElement(require('react-native').ScrollView, props),
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  Stack: { Screen: () => null },
  useLocalSearchParams: jest.fn(() => ({ sessionId: 'session-1' })),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('../lib/liveMeetingSTT', () => ({
  liveMeetingSTT: {
    configureMeeting: jest.fn(),
    pendingAudioBuffers: jest.fn().mockResolvedValue([]),
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
  recoverMeetingAudio: jest.fn().mockResolvedValue(undefined),
  discardMeetingAudio: jest.fn().mockResolvedValue(undefined),
  pauseMeeting: jest.fn().mockResolvedValue(undefined),
  resumeMeeting: jest.fn().mockResolvedValue(undefined),
  updateSpeakerEdits: jest.fn().mockResolvedValue(undefined),
  clearSpeakerNameSuggestion: jest.fn(),
}));
jest.mock('../lib/liveMeetingStore', () => ({
  listMeetings: jest.fn().mockResolvedValue([]),
  listNotes: jest.fn().mockResolvedValue([]),
  loadDraftNote: jest.fn().mockResolvedValue(null),
  saveNote: jest.fn().mockResolvedValue(undefined),
  updateNote: jest.fn().mockResolvedValue(undefined),
  updateMeetingTitle: jest.fn().mockResolvedValue(undefined),
  finalizeNote: jest.fn().mockResolvedValue(true),
}));
jest.mock('../lib/liveMeetingSync', () => ({
  subscribeMeetingSyncFailure: jest.fn().mockReturnValue(() => {}),
  getMeetingSyncFailure: jest.fn().mockReturnValue(null),
  retryMeetingSync: jest.fn().mockResolvedValue(undefined),
  finalizeMeetingOnServer: jest.fn().mockResolvedValue(undefined),
  syncMeetingSession: jest.fn().mockResolvedValue({ pending: false }),
  followRemoteMeeting: jest.fn(),
  discardFinishedMeeting: jest.fn().mockResolvedValue(undefined),
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
  jest.mocked(getMeetingSyncFailure).mockReturnValue(null);
  jest.mocked(useLocalSearchParams).mockReturnValue({ sessionId: 'session-1' });
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
  jest.mocked(liveMeetingSTT!.pendingAudioBuffers!).mockResolvedValue([]);
});

// The transcript groups lines under a speaker heading, so "who said it" is the nearest
// heading before the words. A plain /Speaker 1.*Hello/ would also match a line that
// follows Speaker 1's heading through someone else's turn.
// The ended meeting keeps reference material collapsed under "<name> · <count>".
async function openSection(name: string) {
  fireEvent.press(await screen.findByText(new RegExp(`^${name}( · \\d+)?$`)));
}

function expectTurn(speaker: string, words: RegExp | string) {
  const parts = screen
    .getByTestId('meeting-transcript')
    .findAll((node) => typeof node.props.children === 'string' && String(node.type) === 'Text')
    .map((node) => String(node.props.children));
  const heading = /^(Speaker \d+|Unknown speaker|Anna|Ben)$/;
  let current: string | null = null;
  const owners: string[] = [];
  for (const part of parts) {
    if (heading.test(part)) current = part;
    else if (typeof words === 'string' ? part.includes(words) : words.test(part))
      owners.push(current ?? '');
  }
  expect(owners).toContain(speaker);
}

it('passes the selected expected group size when starting a meeting', async () => {
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByRole('radio', { name: /^Up to 4 people/ }));
  expect(screen.getByRole('radio', { name: /^Up to 4 people/ }).props.accessibilityState).toEqual(
    expect.objectContaining({ checked: true }),
  );
  fireEvent.press(screen.getByLabelText('Start meeting'));
  await waitFor(() => expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', 4));
});

it('offers larger groups and passes their size to the recorder', async () => {
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByRole('radio', { name: /^Larger group/ }));
  fireEvent.press(screen.getByLabelText('Start meeting'));
  await waitFor(() => expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', 10));
});

it('keeps raw audio buffering off unless explicitly enabled before starting', async () => {
  render(<MeetingScreen />);
  const toggle = await screen.findByLabelText('Audio safety buffer, off');
  fireEvent.press(toggle);
  expect(screen.getByLabelText('Audio safety buffer, on')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Start meeting'));
  await waitFor(() =>
    expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', 4, undefined, {
      audioSafetyBuffer: true,
    }),
  );
});

it('offers explicit local recovery only for saved audio belonging to this session', async () => {
  const saved: MeetingRecord = {
    id: 'audio-meeting',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    state: 'ended',
    transcript: '',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([saved]);
  jest.mocked(liveMeetingSTT!.pendingAudioBuffers!).mockResolvedValue([
    { meetingId: 'audio-meeting', duration: 12, segments: 1, locale: 'de-DE' },
    { meetingId: 'another-session', duration: 20, segments: 1, locale: 'de-DE' },
  ]);
  render(<MeetingScreen />);
  expect(await screen.findByText(/Recover locally with Apple Speech/)).toBeOnTheScreen();
  expect(screen.getAllByText('Recover audio')).toHaveLength(1);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(recoverMeetingAudio).mockRejectedValueOnce(new Error('Language assets missing'));
  fireEvent.press(screen.getByText('Recover audio'));
  await waitFor(() => expect(recoverMeetingAudio).toHaveBeenCalledWith('audio-meeting'));
  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith(
      'Could not recover audio',
      expect.stringContaining('Language assets missing'),
    ),
  );
  expect(screen.getByText('Recover audio')).toBeOnTheScreen();
  alert.mockRestore();
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(currentMeeting).mockReturnValue(meeting);
  let publish!: (meeting: MeetingRecord | null) => void;
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    publish = listener;
    listener(meeting);
    return jest.fn();
  });
  render(<MeetingScreen />);
  expect(await screen.findByText('No one has spoken yet.')).toBeOnTheScreen();
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  const sendTurn = jest.fn().mockResolvedValue({ turnId: 'turn-1' });
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    getSession: jest.fn().mockResolvedValue({ model: 'claude-opus-5-5', projectId: 'project' }),
    listModels: jest.fn().mockResolvedValue({ models: ['claude-sonnet-5-5'] }),
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
      {
        id: 'question-release',
        meetingId: meeting.id,
        kind: 'research',
        summary: 'Is the release still Friday?',
        evidenceA: 'Is the release still Friday?',
        evidenceB: null,
        sourcePath: null,
        createdAt: 2,
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
      expect.objectContaining({
        prompt: expect.stringContaining('Is the release still Friday?'),
        model: 'claude-sonnet-5-5',
      }),
    );
    expect(screen.getByText('Researching…')).toBeOnTheScreen();
  });
  // The suggestion turns into its research card instead of staying beside it.
  expect(screen.queryByLabelText('Research meeting question')).toBeNull();
  expect(screen.queryByText(/Project knowledge and the web/)).toBeNull();
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
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
              { seq: 8, event: { t: 'text', delta: '- The roadmap confirms **Tuesday**.' } },
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
  expect(await screen.findByTestId('meeting-answer')).toBeOnTheScreen();
  // Markdown renders as a bullet with bold text, never as raw markers.
  expect(screen.getByText('The roadmap confirms Tuesday.')).toBeOnTheScreen();
  expect(screen.getByText('•')).toBeOnTheScreen();
  expect(screen.queryByText(/\*\*/)).toBeNull();
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
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
  expect(screen.getByText('Researching…')).toBeOnTheScreen();
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(currentMeeting).mockReturnValue(meeting);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  expectTurn('Speaker 1', /Hello/);
  expectTurn('Unknown speaker', /yes/);
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  expectTurn('Speaker 1', /Hello,/);
  expect(screen.getByText('from the meeting')).toBeOnTheScreen();
});

// Words the diarizer had not reached yet were labelled Unknown speaker for about a
// second; open turns now attribute them live and the rest wait without a label.
it('attributes live words from open diarizer turns and leaves unreached words pending', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-pending',
    sessionId: 'session-1',
    serverId: null,
    engine: 'apple-speech',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'Hello there. Still talking',
    error: null,
    speakerStatus: 'ready',
    speakerTurns: [{ speaker: 0, start: 0, end: 0.6 }],
    tentativeSpeakerTurns: [{ speaker: 1, start: 0.8, end: 1.4 }],
    speakerHorizon: 1.5,
    timedWords: [
      { text: 'Hello', start: 0, end: 0.4 },
      { text: 'there.', start: 0.9, end: 1.3 },
      { text: 'Still', start: 2, end: 2.3 },
      { text: 'talking', start: 2.4, end: 2.8 },
    ],
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  expectTurn('Speaker 1', /Hello/);
  expectTurn('Speaker 2', /there\./);
  expect(screen.getByText('Still talking')).toBeOnTheScreen();
  expect(screen.queryByText(/Unknown speaker/)).toBeNull();
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
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

it('names a speaker only after the suggestion is confirmed', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-suggest',
    sessionId: 'session-1',
    serverId: null,
    engine: 'apple-speech',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'Hallo, ich bin Holger. Hi',
    error: null,
    ownerToken: 'owner',
    speakerTurns: [
      { speaker: 0, start: 0, end: 2 },
      { speaker: 1, start: 3, end: 4 },
    ],
    timedWords: [
      { text: 'Hallo, ich bin Holger.', start: 0, end: 2 },
      { text: 'Hi', start: 3, end: 3.5 },
    ],
    speakerNameSuggestions: [
      { speaker: 0, name: 'Holger', quote: 'Hallo, ich bin Holger.' },
      { speaker: 1, name: 'Anna', quote: 'Hi' },
    ],
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  expect(await screen.findByText('Speaker 1 is Holger?')).toBeOnTheScreen();
  expect(updateSpeakerEdits).not.toHaveBeenCalled();
  // A failed save keeps the suggestion in the recording, so it is offered again.
  jest.mocked(updateSpeakerEdits).mockRejectedValueOnce(new Error('disk full'));
  fireEvent.press(screen.getByLabelText('Yes, Holger'));
  expect(await screen.findByText(/Could not save speaker correction/)).toBeOnTheScreen();
  expect(clearSpeakerNameSuggestion).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Yes, Holger')).toBeOnTheScreen();
  expect(updateSpeakerEdits).toHaveBeenCalledWith(meeting.id, { '0': 'Holger' }, [], {});

  fireEvent.press(screen.getByLabelText('Not Anna'));
  expect(clearSpeakerNameSuggestion).toHaveBeenCalledWith(meeting.id, 1, true);
  expect(updateSpeakerEdits).toHaveBeenCalledTimes(1);
});

it('clears a confirmed name suggestion once the name is saved', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-suggest',
    sessionId: 'session-1',
    serverId: null,
    engine: 'apple-speech',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'Hallo, ich bin Holger. Hi',
    error: null,
    ownerToken: 'owner',
    speakerTurns: [
      { speaker: 0, start: 0, end: 2 },
      { speaker: 1, start: 3, end: 4 },
    ],
    timedWords: [
      { text: 'Hallo, ich bin Holger.', start: 0, end: 2 },
      { text: 'Hi', start: 3, end: 3.5 },
    ],
    speakerNameSuggestions: [
      { speaker: 0, name: 'Holger', quote: 'Hallo, ich bin Holger.' },
      { speaker: 1, name: 'Anna', quote: 'Hi' },
    ],
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  let finish!: () => void;
  jest.mocked(updateSpeakerEdits).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Yes, Holger'));
  await waitFor(() => expect(updateSpeakerEdits).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByLabelText('Yes, Anna'));
  expect(updateSpeakerEdits).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() =>
    expect(clearSpeakerNameSuggestion).toHaveBeenCalledWith(meeting.id, 0, false),
  );
  fireEvent.press(screen.getByLabelText('Yes, Anna'));
  await waitFor(() =>
    expect(updateSpeakerEdits).toHaveBeenLastCalledWith(
      meeting.id,
      { '0': 'Holger', '1': 'Anna' },
      [],
      {},
    ),
  );
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  await openSection('People');
  await screen.findByLabelText('Rename Speaker 1');
  fireEvent.press(screen.getByLabelText('Rename Speaker 1'));
  const reply = prompt.mock.calls.at(-1)?.[2];
  if (typeof reply === 'function') act(() => reply('Anna'));
  await waitFor(() =>
    expect(updateSpeakerEdits).toHaveBeenCalledWith(meeting.id, { '0': 'Anna' }, [], {}),
  );
  fireEvent.press(screen.getByLabelText('Open full transcript'));
  expectTurn('Anna', /Hello/);
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  await openSection('People');
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  await openSection('People');
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  await openSection('People');
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
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
  expect(await screen.findByLabelText('Pause meeting')).toBeOnTheScreen();
  act(() =>
    notify({
      meetingId: meeting.id,
      sessionId: meeting.sessionId,
      status: 'failed',
      message: 'Voice request could not be sent: offline',
    }),
  );
  expect(screen.getByText('Voice request could not be sent: offline')).toBeOnTheScreen();
  expect(screen.getByLabelText('Pause meeting')).toBeOnTheScreen();
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
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

it('preserves a new question typed while the previous request is sending', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-pending-request',
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
  let resolveSend!: () => void;
  const sendTurn = jest.fn().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
  );
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Ask Verity'));
  const input = screen.getByLabelText('Ask Verity about this meeting');
  fireEvent.changeText(input, 'First question');
  fireEvent.press(screen.getByLabelText('Ask Verity in meeting'));
  await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
  fireEvent.changeText(input, 'Next question');
  await act(async () => resolveSend());
  expect(input).toHaveDisplayValue('Next question');
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
  await waitFor(() => expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', 4));
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

  const view = render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Start meeting'));
  fireEvent.changeText(await noteInput(), 'Unsaved decision');
  await screen.findByText('Note not saved yet. Use retry in the note field.');
  expect(screen.getByLabelText('Retry saving note')).toBeOnTheScreen();

  fireEvent.press(screen.getByLabelText('End meeting'));
  await screen.findByText('Ended · note not saved');
  expect(screen.queryByLabelText('Speech recognition')).toBeNull();
  jest.mocked(listMeetings).mockResolvedValue([live]);
  view.unmount();
  render(<MeetingScreen />);
  await screen.findByText('New meeting');
  // The start controls used to stack under the ended meeting and push Start off-screen.
  expect(screen.getByLabelText('Speech recognition')).toBeOnTheScreen();
  expect(screen.getByLabelText('Start meeting')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Open full transcript')).toBeNull();
  // The unsaved note is shown with its own retry, not a hint to cancel back to it.
  expect(screen.getByTestId('unsaved-note')).toBeOnTheScreen();
  expect(screen.getByText('“Unsaved decision”')).toBeOnTheScreen();

  let finishRetry!: () => void;
  jest.mocked(saveNote).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishRetry = resolve;
      }),
  );
  fireEvent.press(screen.getByLabelText('Retry saving note'));
  await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
  const next: MeetingRecord = { ...live, id: 'new-after-recovery', state: 'active', endedAt: null };
  jest.mocked(startMeeting).mockResolvedValueOnce(next);
  jest
    .mocked(currentMeeting)
    .mockImplementation(() => (jest.mocked(startMeeting).mock.calls.length > 1 ? next : live));
  fireEvent.press(screen.getByLabelText('Start meeting'));
  fireEvent.changeText(await noteInput(), 'New meeting note');
  await act(async () => finishRetry());
  expect(screen.getByLabelText('Add a meeting note')).toHaveDisplayValue('New meeting note');
  expect(jest.mocked(saveNote).mock.calls.at(-1)?.[0]).toMatchObject({
    meetingId: next.id,
    text: 'New meeting note',
  });
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
  await screen.findByText('Meeting');
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
  await waitFor(() => expect(screen.queryByText(/Note not saved/)).toBeNull());
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
  expect(
    await screen.findByText('Note not saved yet. Use retry in the note field.'),
  ).toBeOnTheScreen();
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
  // The remounted screen keeps the draft behind the Note button.
  expect(await screen.findByText(/· draft/)).toBeOnTheScreen();
  await noteInput();
  fireEvent.press(screen.getByLabelText('Add note'));
  await act(async () => rejectSave(new Error('disk full')));

  expect(await screen.findByLabelText('Retry saving note')).toBeOnTheScreen();
  expect(screen.getByLabelText('Add a meeting note')).toHaveDisplayValue('Recover me');
});

// Finished meetings are filed in the project knowledge and linked from the session,
// so the meeting screen no longer offers its own way back into them.
it('stays on the live meeting without listing earlier meetings', async () => {
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
  jest.mocked(currentMeeting).mockReturnValue(live);
  jest.mocked(listMeetings).mockResolvedValue([live, past]);
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    listener(live);
    return jest.fn();
  });

  render(<MeetingScreen />);
  await waitFor(() => expect(listNotes).toHaveBeenCalledWith('live'));
  expect(screen.queryByText(/EARLIER MEETINGS/)).toBeNull();
  expect(screen.queryByText(/· ended/)).toBeNull();
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  await screen.findByText('Live text');
  expect(screen.queryByText('Historical transcript')).toBeNull();
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest
    .mocked(listNotes)
    .mockResolvedValue([{ id: 'n', meetingId: meeting.id, atSeconds: 90, text: 'Budget' }]);
  render(<MeetingScreen />);
  const expected = new Date(startedAt + 90_000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  await openSection('Your notes');
  expect(await screen.findByTestId('meeting-note')).toHaveTextContent(`${expected} Budget`);
  expect(expected).not.toBe('01:30');
});

it('opens online configuration without exposing provider details on the start screen', async () => {
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByText(/Online meeting/));
  expect(screen.queryByText(/Attendee/)).toBeNull();
  expect(
    screen.getByText('Configure online meetings and enable Verity Premium Online sharing.'),
  ).toBeTruthy();
  fireEvent.press(screen.getByText('Configure online meetings'));
  expect(router.push).toHaveBeenCalledWith('/settings/services');
  fireEvent.press(screen.getByText('Verity Premium'));
  expect(router.push).toHaveBeenCalledWith('/settings/premium');
  fireEvent.press(screen.getByLabelText('Start meeting'));
  expect(startMeeting).not.toHaveBeenCalled();
});

it('allows cancellation of an interrupted online bot start', async () => {
  const remote: MeetingRecord = {
    id: 'online-pending',
    sessionId: 'session-1',
    serverId: 'server-1',
    engine: 'attendee',
    startedAt: Date.now(),
    endedAt: null,
    state: 'interrupted',
    captureStatus: 'preparing',
    transcript: '',
    error: 'Recovering bot creation',
  };
  const stopOnlineMeeting = jest.fn().mockResolvedValue({ accepted: true });
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
  jest
    .mocked(createVerityClient)
    .mockReturnValue({ stopOnlineMeeting } as unknown as NonNullable<
      ReturnType<typeof createVerityClient>
    >);
  jest.mocked(listMeetings).mockResolvedValue([remote]);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('End meeting'));
  await waitFor(() => expect(stopOnlineMeeting).toHaveBeenCalledWith('session-1', remote.id));
});

it('renames an online speaker using synchronized names without replacing other edits', async () => {
  const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => undefined);
  const meeting: MeetingRecord = {
    id: 'online-names',
    sessionId: 'session-1',
    serverId: 'server-1',
    engine: 'attendee',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: 'Hello',
    error: null,
    speakerNames: { '0': 'Alice', '1': 'Bob' },
    speakerTurns: [{ speaker: 0, start: 0, end: 1 }],
    timedWords: [{ text: 'Hello', start: 0, end: 0.5 }],
  };
  const editOnlineMeetingSpeakers = jest.fn().mockResolvedValue({ accepted: true });
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
  jest
    .mocked(createVerityClient)
    .mockReturnValue({ editOnlineMeetingSpeakers } as unknown as NonNullable<
      ReturnType<typeof createVerityClient>
    >);
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  let publish!: (meeting: MeetingRecord | null) => void;
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    publish = listener;
    return jest.fn();
  });
  render(<MeetingScreen />);
  await screen.findByLabelText('Rename Alice');
  act(() =>
    publish({
      ...meeting,
      speakerNames: { '0': 'Alice', '1': 'Remote Bob' },
      speakerCorrections: [{ start: 0, end: 0.5, speaker: 1 }],
      speakerMerges: { '2': 1 },
    }),
  );
  fireEvent.press(screen.getByLabelText('Rename Alice'));
  const reply = prompt.mock.calls.at(-1)?.[2];
  if (typeof reply === 'function') act(() => reply('Anna'));
  await waitFor(() =>
    expect(editOnlineMeetingSpeakers).toHaveBeenCalledWith('session-1', meeting.id, {
      speakerNames: { '0': 'Anna', '1': 'Remote Bob' },
    }),
  );
  prompt.mockRestore();
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
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
      {
        id: 'question-release',
        meetingId: meeting.id,
        kind: 'research',
        summary: 'Is the release still Friday?',
        evidenceA: 'Is the release still Friday?',
        evidenceB: null,
        sourcePath: null,
        createdAt: 2,
      },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  fireEvent.press((await screen.findAllByLabelText('Save as note'))[0]!);
  await waitFor(() =>
    expect(saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: meeting.id, text: 'The delivery dates differ.' }),
    ),
  );
  await waitFor(() => expect(finalizeNote).toHaveBeenCalled());
  expect(await screen.findByTestId('meeting-note')).toHaveTextContent(
    /The delivery dates differ\./,
  );
  expect(screen.getAllByLabelText('Save as note')).toHaveLength(1);

  expect(screen.getByText('Is the release still Friday?')).toBeOnTheScreen();
  // The open question is the last card, after the insight it did not come from.
  fireEvent.press(screen.getAllByLabelText('Dismiss meeting question').at(-1)!);
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
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
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

it('keeps one card per question, expands the newest answer and dismisses without cancelling', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-cards',
    sessionId: 'session-1',
    serverId: null,
    engine: 'apple-speech',
    startedAt: 1,
    endedAt: null,
    state: 'active',
    transcript: 'What is the price? When is delivery?',
    error: null,
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  const cancelTurn = jest.fn();
  const questionPrompt = (question: string, id: string) =>
    `Research this point raised during live meeting ${meeting.id}:\n\n${question}\n\nRecent meeting transcript:\n${meeting.transcript}\n\nMeeting question reference: ${id}`;
  jest.mocked(createVerityClient).mockReturnValue({
    cancelTurn,
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getHistory: jest.fn().mockResolvedValue({
      hasMore: false,
      events: [
        {
          seq: 1,
          event: { t: 'prompt', text: questionPrompt('What is the price?', 'question-price') },
        },
        { seq: 2, event: { t: 'text', delta: '- Price is ten.\n- Tax is included.' } },
        { seq: 3, event: { t: 'result' } },
        {
          seq: 4,
          event: { t: 'prompt', text: questionPrompt('When is delivery?', 'question-delivery') },
        },
        {
          seq: 5,
          event: { t: 'text', delta: '- Delivery is Tuesday.\n- Tracking arrives Monday.' },
        },
        { seq: 6, event: { t: 'result' } },
      ],
    }),
    getActivity: jest.fn().mockResolvedValue({ busy: false, queued: [] }),
    getLiveMeetingInsights: jest.fn().mockResolvedValue([
      {
        id: 'question-price',
        meetingId: meeting.id,
        kind: 'research',
        summary: 'How much is it?',
        evidenceA: 'What is the price?',
        evidenceB: null,
        sourcePath: null,
        createdAt: 1,
      },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  expect(await screen.findByText('Tracking arrives Monday.')).toBeOnTheScreen();
  expect(screen.queryByText('Tax is included.')).toBeNull();
  expect(screen.queryByText('How much is it?')).toBeNull();
  expect(screen.getAllByText('What is the price?')).toHaveLength(1);
  fireEvent.press(screen.getAllByLabelText('Toggle meeting answer')[0]!);
  expect(screen.getByText('Tax is included.')).toBeOnTheScreen();
  expect(screen.queryByText('Tracking arrives Monday.')).toBeNull();
  fireEvent.press(screen.getAllByLabelText('Dismiss meeting answer')[1]!);
  expect(screen.queryByText('When is delivery?')).toBeNull();
  expect(cancelTurn).not.toHaveBeenCalled();
});

it('replaces a question suggestion with a paraphrased spoken request using its stable identity', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-voice-id',
    sessionId: 'session-1',
    serverId: null,
    engine: 'apple-speech',
    startedAt: 1,
    endedAt: null,
    state: 'active',
    transcript: 'What does the plan cost?',
    error: null,
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  let notify!: Parameters<typeof subscribeVoiceMeetingRequest>[0];
  jest.mocked(subscribeVoiceMeetingRequest).mockImplementation((listener) => {
    notify = listener;
    return jest.fn();
  });
  jest.mocked(createVerityClient).mockReturnValue({
    getHistory: jest.fn().mockResolvedValue({ hasMore: false, events: [] }),
    getActivity: jest.fn().mockResolvedValue({ busy: false, queued: [] }),
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getLiveMeetingInsights: jest.fn().mockResolvedValue([
      {
        id: 'question-price',
        meetingId: meeting.id,
        kind: 'research',
        summary: 'What does the plan cost?',
        evidenceA: 'What does the plan cost?',
        evidenceB: null,
        sourcePath: null,
        createdAt: 1,
      },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  expect(await screen.findByLabelText('Research meeting question')).toBeOnTheScreen();
  act(() =>
    notify({
      meetingId: meeting.id,
      sessionId: 'session-1',
      status: 'sent',
      kind: 'research',
      request: 'research its monthly price',
      requestId: 'voice-price',
      questionId: 'question-price',
      questionTitle: 'What does the plan cost?',
    }),
  );
  expect(screen.getAllByText('What does the plan cost?')).toHaveLength(1);
  expect(screen.queryByText('research its monthly price')).toBeNull();
  expect(screen.queryByLabelText('Research meeting question')).toBeNull();
});

it.each([false, true])(
  'limits history answers after merging repeated requests across pages: %s',
  async (paginate) => {
    const meeting: MeetingRecord = {
      id: 'meeting-history-limit',
      sessionId: 'session-1',
      serverId: null,
      engine: 'apple-speech',
      startedAt: 1,
      endedAt: null,
      state: 'active',
      transcript: 'Meeting text.',
      error: null,
    };
    jest
      .mocked(useLocalSearchParams)
      .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
    jest.mocked(listMeetings).mockResolvedValue([meeting]);
    const requests = [
      'What is the price?',
      'When is delivery?',
      ...Array<string>(4).fill('Where is the venue?'),
    ];
    const events = requests.flatMap((question, index) => [
      {
        seq: index * 3 + 1,
        event: {
          t: 'prompt',
          text: `Research this point raised during live meeting ${meeting.id}:\n\n${question}\n\nRecent meeting transcript:\n${meeting.transcript}`,
        },
      },
      { seq: index * 3 + 2, event: { t: 'text', delta: `Answer ${index}.` } },
      { seq: index * 3 + 3, event: { t: 'result' } },
    ]);
    jest.mocked(createVerityClient).mockReturnValue({
      getHistory: jest
        .fn()
        .mockImplementation(async (_sessionId, options) =>
          paginate
            ? options?.beforeSeq
              ? { hasMore: false, events: events.slice(0, 6) }
              : { hasMore: true, events: events.slice(6) }
            : { hasMore: false, events },
        ),
      getActivity: jest.fn().mockResolvedValue({ busy: false, queued: [] }),
      getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
      getLiveMeetingInsights: jest.fn().mockResolvedValue([]),
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    render(<MeetingScreen />);
    expect(await screen.findByText('Where is the venue?')).toBeOnTheScreen();
    expect(screen.getByText('What is the price?')).toBeOnTheScreen();
    expect(screen.getByText('When is delivery?')).toBeOnTheScreen();
    expect(screen.getAllByText('Where is the venue?')).toHaveLength(1);
  },
);

it.each(['requested', 'dismissed'])(
  'applies the suggestion limit after excluding %s questions',
  async (hidden) => {
    const meeting: MeetingRecord = {
      id: 'meeting-suggestion-limit',
      sessionId: 'session-1',
      serverId: null,
      engine: 'apple-speech',
      startedAt: 1,
      endedAt: null,
      state: 'active',
      transcript: 'Meeting text.',
      error: null,
    };
    jest
      .mocked(useLocalSearchParams)
      .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
    jest.mocked(listMeetings).mockResolvedValue([meeting]);
    const insights = Array.from({ length: 5 }, (_, index) => ({
      id: `question-${index}`,
      meetingId: meeting.id,
      kind: 'research',
      summary: `Question ${index}?`,
      evidenceA: `Question ${index}?`,
      evidenceB: null,
      sourcePath: null,
      createdAt: index,
    }));
    const events =
      hidden === 'requested'
        ? insights.slice(0, 4).flatMap((insight, index) => [
            {
              seq: index * 3 + 1,
              event: {
                t: 'prompt',
                text: `Research this point raised during live meeting ${meeting.id}:\n\n${insight.summary}\n\nRecent meeting transcript:\n${meeting.transcript}\n\nMeeting question reference: ${insight.id}`,
              },
            },
            { seq: index * 3 + 2, event: { t: 'text', delta: 'An answer.' } },
            { seq: index * 3 + 3, event: { t: 'result' } },
          ])
        : [];
    jest.mocked(createVerityClient).mockReturnValue({
      getHistory: jest.fn().mockResolvedValue({ hasMore: false, events }),
      getActivity: jest.fn().mockResolvedValue({ busy: false, queued: [] }),
      getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
      getLiveMeetingInsights: jest.fn().mockResolvedValue(insights),
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    render(<MeetingScreen />);
    if (hidden === 'dismissed') {
      await screen.findByText('Question 0?');
      for (let index = 0; index < 4; index++)
        fireEvent.press(screen.getAllByLabelText('Dismiss meeting question')[0]!);
    }
    expect(await screen.findByText('Question 4?')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Research meeting question')).toHaveLength(1);
  },
);

it('keeps a pending question whose wording matches an answer for a different question identity', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-distinct-pending',
    sessionId: 'session-1',
    serverId: null,
    engine: 'apple-speech',
    startedAt: 1,
    endedAt: null,
    state: 'active',
    transcript: 'Meeting text.',
    error: null,
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  const question = 'What is the price?';
  jest.mocked(createVerityClient).mockReturnValue({
    getHistory: jest.fn().mockResolvedValue({
      hasMore: false,
      events: [
        {
          seq: 1,
          event: {
            t: 'prompt',
            text: `Research this point raised during live meeting ${meeting.id}:\n\n${question}\n\nRecent meeting transcript:\n${meeting.transcript}\n\nMeeting question reference: question-other`,
          },
        },
        { seq: 2, event: { t: 'text', delta: 'An earlier price.' } },
        { seq: 3, event: { t: 'result' } },
      ],
    }),
    getActivity: jest.fn().mockResolvedValue({ busy: false, queued: [] }),
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getLiveMeetingInsights: jest.fn().mockResolvedValue([
      {
        id: 'question-pending',
        meetingId: meeting.id,
        kind: 'research',
        summary: question,
        evidenceA: question,
        evidenceB: null,
        sourcePath: null,
        createdAt: 1,
      },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  expect(await screen.findByText('An earlier price.')).toBeOnTheScreen();
  expect(screen.getByLabelText('Research meeting question')).toBeOnTheScreen();
});

it('resets answer dismissal when switching to another meeting with the same request', async () => {
  let meeting: MeetingRecord = {
    id: 'meeting-first',
    sessionId: 'session-1',
    serverId: null,
    engine: 'apple-speech',
    startedAt: 1,
    endedAt: null,
    state: 'active',
    transcript: 'Check the price.',
    error: null,
  };
  let notify!: (meeting: MeetingRecord | null) => void;
  jest.mocked(currentMeeting).mockImplementation(() => meeting);
  jest.mocked(listMeetings).mockImplementation(async () => [meeting]);
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    notify = listener;
    listener(meeting);
    return jest.fn();
  });
  jest.mocked(createVerityClient).mockReturnValue({
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getHistory: jest.fn().mockImplementation(async () => ({
      hasMore: false,
      events: [
        {
          seq: 1,
          event: {
            t: 'prompt',
            text: `Research this point raised during live meeting ${meeting.id}:\n\nCheck the price.\n\nRecent meeting transcript:\n${meeting.transcript}`,
          },
        },
        { seq: 2, event: { t: 'text', delta: '- Price is ten.' } },
        { seq: 3, event: { t: 'result' } },
      ],
    })),
    getActivity: jest.fn().mockResolvedValue({ busy: false, queued: [] }),
    getLiveMeetingInsights: jest.fn().mockResolvedValue([]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  expect(await screen.findByText('Price is ten.')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Dismiss meeting answer'));
  expect(screen.queryByText('Price is ten.')).toBeNull();
  meeting = { ...meeting, id: 'meeting-second' };
  await act(async () => notify(meeting));
  expect(await screen.findByText('Price is ten.')).toBeOnTheScreen();
});

it('opens a fresh start instead of the latest saved meeting', async () => {
  jest.mocked(useLocalSearchParams).mockReturnValue({ sessionId: 'session-1' });
  jest.mocked(listMeetings).mockResolvedValue([
    {
      id: 'old-meeting',
      sessionId: 'session-1',
      engine: 'fluid-nemotron',
      startedAt: 1,
      endedAt: 2,
      state: 'ended',
      transcript: 'Old transcript',
      error: null,
    },
  ]);
  render(<MeetingScreen />);
  await waitFor(() => expect(listMeetings).toHaveBeenCalled());
  expect(await screen.findByText('New meeting')).toBeTruthy();
  expect(screen.queryByText('Old transcript')).toBeNull();
});

it('opens an explicitly selected ended meeting even when it is still the local record', async () => {
  const meeting: MeetingRecord = {
    id: 'ended-local',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: 1,
    endedAt: 2,
    state: 'ended',
    transcript: 'Saved words',
    error: null,
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(currentMeeting).mockReturnValue(meeting);
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  expect(await screen.findByText(/^Ended/)).toBeTruthy();
});

it('preserves entered text through both composer switches', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-1',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  const input = await noteInput();
  fireEvent.changeText(input, 'Draft for Friday');
  fireEvent.press(screen.getByLabelText('Switch to Ask Verity'));
  expect(screen.getByLabelText('Ask Verity about this meeting').props.value).toBe(
    'Draft for Friday',
  );
  fireEvent.changeText(screen.getByLabelText('Ask Verity about this meeting'), 'Draft for Monday');
  fireEvent.press(screen.getByLabelText('Switch to note'));
  expect(screen.getByLabelText('Add a meeting note').props.value).toBe('Draft for Monday');
});

it('passes the chosen title to the recorder', async () => {
  render(<MeetingScreen />);
  fireEvent.changeText(await screen.findByLabelText('Meeting title'), 'Pricing sync');
  fireEvent.press(screen.getByLabelText('Start meeting'));
  await waitFor(() =>
    expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', 4, 'Pricing sync'),
  );
});

it('hides recording controls while the full-screen transcript is open', async () => {
  const meeting: MeetingRecord = {
    id: 'transcript-full',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: 'Hello',
    captureStatus: 'listening',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Open full transcript'));
  expect(screen.queryByLabelText('Pause meeting')).toBeNull();
  expect(screen.queryByLabelText('End meeting')).toBeNull();
  fireEvent.press(screen.getByLabelText('Collapse transcript'));
  expect(await screen.findByLabelText('Pause meeting')).toBeTruthy();
});

it('recovers a persisted unfinished note on a fresh offline entry without showing the ended meeting', async () => {
  const old: MeetingRecord = {
    id: 'persisted-offline',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: 1,
    endedAt: 2,
    state: 'ended',
    transcript: 'Old transcript',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([old]);
  jest.mocked(loadDraftNote).mockResolvedValueOnce({
    id: 'persisted-note',
    meetingId: old.id,
    atSeconds: 1,
    text: 'Finish this offline note',
  });
  render(<MeetingScreen />);
  expect(await screen.findByText('“Finish this offline note”')).toBeOnTheScreen();
  expect(screen.getByText('New meeting')).toBeOnTheScreen();
  expect(screen.queryByText('Old transcript')).toBeNull();
  fireEvent.press(screen.getByLabelText('Save recovered note'));
  await waitFor(() =>
    expect(finalizeNote).toHaveBeenCalledWith('persisted-note', 'Finish this offline note'),
  );
  await waitFor(() => expect(screen.queryByTestId('unsaved-note')).toBeNull());
});

it('counts the complete ended answer history across pages and keeps the count after dismissal', async () => {
  const meeting: MeetingRecord = {
    id: 'summary-six-answers',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: 1,
    endedAt: 2,
    state: 'ended',
    transcript: '',
    error: null,
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  const events = Array.from({ length: 6 }, (_, index) => [
    {
      seq: index * 3 + 1,
      event: {
        t: 'prompt',
        text: `During live meeting ${meeting.id}, please respond to this request:\n\nQuestion ${index}?\n\nRecent meeting transcript:\ntext`,
      },
    },
    { seq: index * 3 + 2, event: { t: 'text', delta: `Answer ${index}.` } },
    { seq: index * 3 + 3, event: { t: 'result' } },
  ]).flat();
  jest.mocked(createVerityClient).mockReturnValue({
    getHistory: jest
      .fn()
      .mockImplementation(async (_sessionId, options) =>
        options?.beforeSeq
          ? { hasMore: false, events: events.slice(0, 3) }
          : { hasMore: true, events: events.slice(3) },
      ),
    getActivity: jest.fn().mockResolvedValue({ busy: false, queued: [] }),
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    getLiveMeetingInsights: jest.fn().mockResolvedValue([]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  await openSection('Verity’s answers');
  expect(screen.getByText('Verity’s answers · 6')).toBeOnTheScreen();
  expect(screen.getByText('Answer 0.')).toBeOnTheScreen();
  fireEvent.press(screen.getAllByLabelText('Dismiss meeting answer')[0]!);
  expect(screen.getByText('Verity’s answers · 6')).toBeOnTheScreen();
});

it('preserves the note draft when returning after sending an Ask', async () => {
  const meeting: MeetingRecord = {
    id: 'sent-ask',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  };
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn: jest.fn().mockResolvedValue({ turnId: 'turn-1' }),
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<MeetingScreen />);
  fireEvent.changeText(await noteInput(), 'Keep my note');
  fireEvent.press(screen.getByLabelText('Switch to Ask Verity'));
  fireEvent.press(screen.getByLabelText('Ask Verity in meeting'));
  await waitFor(() =>
    expect(screen.getByLabelText('Ask Verity about this meeting')).toHaveDisplayValue(''),
  );
  fireEvent.press(screen.getByLabelText('Switch to note'));
  expect(screen.getByLabelText('Add a meeting note')).toHaveDisplayValue('Keep my note');
});

it('edits the ended title and a personal note, then searches the transcript', async () => {
  const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => undefined);
  const ended: MeetingRecord = {
    id: 'result-edits',
    sessionId: 'session-1',
    engine: 'apple-speech',
    startedAt: 100,
    endedAt: 200,
    state: 'ended',
    transcript: 'Release in Paris. Budget in London.',
    error: null,
    ownerToken: 'owner',
    title: 'Release',
    speakerTurns: [
      { speaker: 0, start: 0, end: 1 },
      { speaker: 1, start: 1, end: 2 },
    ],
    timedWords: [
      { text: 'Release in Paris.', start: 0, end: 0.8 },
      { text: 'Budget in London.', start: 1, end: 1.8 },
    ],
    speakerNames: { '0': 'Anna', '1': 'Ben' },
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: ended.id });
  jest.mocked(listMeetings).mockResolvedValue([ended]);
  const note = { id: 'personal', meetingId: ended.id, atSeconds: 1, text: 'Check tickets' };
  jest.mocked(listNotes).mockResolvedValue([note]);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByLabelText('Edit meeting title'));
  const titleReply = prompt.mock.calls.at(-1)?.[2];
  if (typeof titleReply === 'function') act(() => titleReply('Trip planning'));
  await waitFor(() => expect(updateMeetingTitle).toHaveBeenCalledWith(ended.id, 'Trip planning'));
  await openSection('Your notes');
  fireEvent.press(screen.getByLabelText('Edit note: Check tickets'));
  const noteReply = prompt.mock.calls.at(-1)?.[2];
  if (typeof noteReply === 'function') act(() => noteReply('Book tickets'));
  await waitFor(() => expect(updateNote).toHaveBeenCalledWith(note, 'Book tickets'));
  fireEvent.press(screen.getByLabelText('Open full transcript'));
  fireEvent.changeText(screen.getByLabelText('Search transcript'), 'Anna');
  expect(screen.getByText(/Release in Paris/)).toBeOnTheScreen();
  expect(screen.queryByText(/Budget in London/)).toBeNull();
  fireEvent.changeText(screen.getByLabelText('Search transcript'), 'London');
  expect(screen.getByText(/Budget in London/)).toBeOnTheScreen();
  expect(screen.queryByText(/Release in Paris/)).toBeNull();
  prompt.mockRestore();
});

it('lets a second device save notes and ask research without starting its microphone', async () => {
  const remote: MeetingRecord = {
    id: 'collaborative-phone',
    sessionId: 'session-1',
    serverId: 'server-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now() - 120000,
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: 'Discuss the launch.',
    error: null,
  };
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
  jest.mocked(listMeetings).mockResolvedValue([remote]);
  const sendTurn = jest.fn().mockResolvedValue({ turnId: 'research-from-ipad' });
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: false }),
  } as never);
  render(<MeetingScreen />);
  await screen.findByText(/Recording device unreachable.*transcript may be out of date/);
  fireEvent.changeText(await noteInput(), 'Check launch date');
  fireEvent.press(screen.getByLabelText('Add note'));
  await waitFor(() =>
    expect(finalizeNote).toHaveBeenCalledWith(expect.any(String), 'Check launch date'),
  );
  fireEvent.press(screen.getByLabelText('Switch to Ask Verity'));
  fireEvent.changeText(
    screen.getByLabelText('Ask Verity about this meeting'),
    'Research the launch requirements',
  );
  fireEvent.press(screen.getByLabelText('Ask Verity in meeting'));
  await waitFor(() =>
    expect(sendTurn).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        prompt: expect.stringContaining(remote.id),
      }),
    ),
  );
  expect(saveNote).toHaveBeenCalledWith(
    expect.objectContaining({ meetingId: remote.id, text: 'Check launch date' }),
  );
  expect(startMeeting).not.toHaveBeenCalled();
  expect(endMeeting).not.toHaveBeenCalled();
});

it('leaves a directly opened meeting screen when Cancel has no history', async () => {
  jest.mocked(router.canGoBack).mockReturnValueOnce(false);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByText('Cancel'));
  expect(router.replace).toHaveBeenCalledWith({
    pathname: '/session/[id]',
    params: { id: 'session-1' },
  });
});

it('shows calendar entries for in-person meetings and uses the selected title', async () => {
  jest.mocked(createVerityClient).mockReturnValue({
    getUpcomingMeetings: jest.fn().mockResolvedValue([
      {
        eventKey: 'office',
        title: 'Office review',
        startsAt: Date.now(),
        endsAt: Date.now() + 3600000,
        calendar: 'Work',
        provider: null,
        decision: null,
        meetingId: null,
      },
    ]),
  } as never);
  render(<MeetingScreen />);
  await screen.findByText('Office review');
  await waitFor(() =>
    expect(screen.getByLabelText('Meeting title').props.value).toBe('Office review'),
  );
  fireEvent.press(await screen.findByRole('radio', { name: /^Up to 4 people/ }));
  fireEvent.press(screen.getByLabelText('Start meeting'));
  await waitFor(() =>
    expect(startMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', 4, 'Office review'),
  );
});

it('keeps manual meeting link entry in a keyboard-aware form', async () => {
  jest.mocked(createVerityClient).mockReturnValue({
    getUpcomingMeetings: jest.fn().mockResolvedValue([]),
  } as never);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByText('Online meeting'));
  await waitFor(() => expect(screen.getByLabelText('Online meeting link')).toBeOnTheScreen());
  const form = screen.UNSAFE_getByType(KeyboardAwareScrollView);
  expect(form.findByProps({ accessibilityLabel: 'Online meeting link' })).toBeTruthy();
  expect(form.props.bottomOffset).toBe(KEYBOARD_BOTTOM_OFFSET);
  fireEvent.changeText(
    screen.getByLabelText('Online meeting link'),
    'https://meet.google.com/abc-defg-hij',
  );
  expect(screen.getByLabelText('Online meeting link').props.value).toBe(
    'https://meet.google.com/abc-defg-hij',
  );
});

it('does not join a later in-person selection after switching to online', async () => {
  const joinCalendarMeeting = jest.fn();
  const startOnlineMeeting = jest.fn();
  jest.mocked(createVerityClient).mockReturnValue({
    getAttendeeSettings: jest.fn().mockResolvedValue({ configured: true }),
    getUpcomingMeetings: jest.fn().mockResolvedValue([
      {
        eventKey: 'later',
        title: 'Later review',
        startsAt: Date.now() + 3_600_000,
        endsAt: Date.now() + 7_200_000,
        calendar: 'Work',
        provider: 'meet',
        decision: null,
        meetingId: null,
      },
    ]),
    joinCalendarMeeting,
    startOnlineMeeting,
  } as never);
  render(<MeetingScreen />);
  fireEvent.press(await screen.findByText('Later review'));
  await waitFor(() =>
    expect(screen.getByLabelText('Meeting title').props.value).toBe('Later review'),
  );
  fireEvent.press(screen.getByText('Online meeting'));
  await waitFor(() => expect(screen.queryByText('Configure online meetings')).toBeNull());
  await waitFor(() => expect(screen.getByLabelText('Start meeting')).toBeDisabled());
  fireEvent.press(screen.getByLabelText('Start meeting'));
  expect(joinCalendarMeeting).not.toHaveBeenCalled();
  expect(startOnlineMeeting).not.toHaveBeenCalled();
});

it('preserves a typed title when calendar loading finishes and uses a deliberately selected title', async () => {
  let resolveEvents!: (events: unknown[]) => void;
  const pending = new Promise<unknown[]>((resolve) => {
    resolveEvents = resolve;
  });
  jest
    .mocked(createVerityClient)
    .mockReturnValue({ getUpcomingMeetings: jest.fn().mockReturnValue(pending) } as never);
  render(<MeetingScreen />);
  fireEvent.changeText(await screen.findByLabelText('Meeting title'), 'My notes');
  await act(async () => {
    resolveEvents([
      {
        eventKey: 'office',
        title: 'Office review',
        startsAt: Date.now(),
        endsAt: Date.now() + 3_600_000,
        calendar: 'Work',
        provider: null,
        decision: null,
        meetingId: null,
      },
    ]);
  });
  await screen.findByText('Office review');
  expect(screen.getByLabelText('Meeting title').props.value).toBe('My notes');
  fireEvent.press(screen.getByText('Office review'));
  await waitFor(() =>
    expect(screen.getByLabelText('Meeting title').props.value).toBe('Office review'),
  );
});

it('discards a finished meeting only after confirmation', async () => {
  const measure = jest
    .spyOn(require('react-native').View.prototype, 'measureInWindow')
    .mockImplementation(function (this: unknown, callback: unknown) {
      (callback as (x: number, y: number, w: number, h: number) => void)(300, 40, 40, 40);
    });
  const meeting: MeetingRecord = {
    id: 'meeting-discard',
    sessionId: 'session-1',
    serverId: null,
    engine: 'fluid-nemotron',
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    state: 'ended',
    title: 'Weekly sync',
    transcript: 'Hello',
    error: null,
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  render(<MeetingScreen />);
  const openDiscard = async () => {
    fireEvent.press(await screen.findByLabelText('Meeting actions'));
    fireEvent.press(await screen.findByText('Discard meeting…'));
    expect(await screen.findByText('Discard “Weekly sync”?')).toBeOnTheScreen();
  };
  await openDiscard();
  expect(
    screen.getByText(/Deletes the transcript and the summary on this device\./),
  ).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Cancel'));
  expect(discardFinishedMeeting).not.toHaveBeenCalled();

  await openDiscard();
  fireEvent.press(screen.getByText('Discard'));
  await waitFor(() =>
    expect(discardFinishedMeeting).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: meeting.id }),
    ),
  );
  measure.mockRestore();
});

function showSyncRecoveryMeeting(state: 'active' | 'ended', error: string | null = null) {
  const meeting: MeetingRecord = {
    id: 'meeting-sync-recovery',
    sessionId: 'session-1',
    serverId: 'server-1',
    engine: 'fluid-nemotron',
    ownerToken: 'owned-on-this-device',
    startedAt: Date.now() - 60_000,
    endedAt: state === 'ended' ? Date.now() : null,
    state,
    captureStatus: state === 'ended' ? 'paused' : 'listening',
    transcript: 'Keep these locally saved words.',
    error,
  };
  jest
    .mocked(useLocalSearchParams)
    .mockReturnValue({ sessionId: 'session-1', meetingId: meeting.id });
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  jest
    .mocked(getMeetingSyncFailure)
    .mockReturnValue({ status: 400, message: 'Sync needs attention' });
  return meeting;
}

it('keeps recovery available after local stop and finalizes without discarding its transcript', async () => {
  const meeting = showSyncRecoveryMeeting('ended');
  render(<MeetingScreen />);
  expect(await screen.findByText('Server end not confirmed')).toBeOnTheScreen();
  expect(screen.getByText(/Your transcript is saved here/)).toBeOnTheScreen();
  fireEvent.press(screen.getByText('End on server'));
  await waitFor(() =>
    expect(finalizeMeetingOnServer).toHaveBeenCalledWith('session-1', meeting.id),
  );
  expect(discardFinishedMeeting).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Retry sync'));
  await waitFor(() => expect(retryMeetingSync).toHaveBeenCalledWith('session-1', meeting.id));
});

it('never offers server finalization while the local recording is active', async () => {
  showSyncRecoveryMeeting('active');
  render(<MeetingScreen />);
  expect(await screen.findByText('Transcript sync needs attention')).toBeOnTheScreen();
  expect(screen.queryByText('End on server')).not.toBeOnTheScreen();
  expect(screen.getByText('Retry sync')).toBeOnTheScreen();
});

it('keeps unsynced changes visible after server finalization without offering another end', async () => {
  showSyncRecoveryMeeting('ended');
  jest.mocked(getMeetingSyncFailure).mockReturnValue({
    status: 400,
    message: 'Sync needs attention',
    serverFinalized: true,
  });
  render(<MeetingScreen />);
  expect(await screen.findByText('Meeting ended on server')).toBeOnTheScreen();
  expect(screen.getByText(/Some transcript changes have not been synced/)).toBeOnTheScreen();
  expect(screen.queryByText('End on server')).not.toBeOnTheScreen();
  expect(screen.getByText('Retry sync')).toBeOnTheScreen();
});

it('does not claim local transcript safety after a local save failure', async () => {
  showSyncRecoveryMeeting('ended', 'Local save failed: storage full');
  render(<MeetingScreen />);
  expect(await screen.findByText('Server end not confirmed')).toBeOnTheScreen();
  expect(screen.queryByText(/Your transcript is saved here/)).not.toBeOnTheScreen();
  expect(screen.getByText(/Check the local save error before leaving/)).toBeOnTheScreen();
});

describe('online meeting joining', () => {
  const online = (fields: Partial<MeetingRecord> = {}): MeetingRecord => ({
    id: 'online-1',
    sessionId: 'session-1',
    serverId: 'server-1',
    engine: 'attendee',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'preparing',
    transcript: '',
    error: null,
    ...fields,
  });
  const serve = <T extends object>(status: string, reason: string | null = null, extra?: T) => {
    const client = {
      getOnlineMeetingStatus: jest.fn().mockResolvedValue({ status, reason, platform: 'teams' }),
      stopOnlineMeeting: jest.fn().mockResolvedValue(undefined),
      getAttendeeSettings: jest.fn().mockResolvedValue({ configured: true }),
      getUpcomingMeetings: jest.fn().mockResolvedValue([]),
      ...(extra as T),
    };
    jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
    jest.mocked(createVerityClient).mockReturnValue(client as never);
    return client;
  };

  // The bot sat in "joining" behind the full meeting screen, which also claimed to prepare
  // the phone's microphone for a meeting the phone does not record.
  it('waits on the joining screen instead of the meeting', async () => {
    serve('joining');
    jest.mocked(listMeetings).mockResolvedValue([online()]);
    render(<MeetingScreen />);
    expect(await screen.findByText('Joining the call')).toBeOnTheScreen();
    expect(await screen.findByText('Microsoft Teams')).toBeOnTheScreen();
    expect(screen.queryByLabelText('End meeting')).toBeNull();
    expect(screen.queryByText(/Preparing microphone/)).toBeNull();
  });

  // An older server has no join status; hiding the meeting behind "Joining" would strand it.
  it('shows the meeting as before when the server has no join status', async () => {
    serve('joining', null, {
      getOnlineMeetingStatus: jest.fn().mockRejectedValue(new VerityApiError(404, 'Not Found')),
    });
    jest.mocked(listMeetings).mockResolvedValue([online()]);
    render(<MeetingScreen />);
    expect(await screen.findByLabelText('End meeting', {}, { timeout: 5000 })).toBeOnTheScreen();
    expect(screen.queryByText('Joining the call')).toBeNull();
  });

  it('shows the waiting room the provider reports', async () => {
    serve('waiting');
    jest.mocked(listMeetings).mockResolvedValue([online()]);
    render(<MeetingScreen />);
    expect(await screen.findByText('Waiting to be let in')).toBeOnTheScreen();
    expect(screen.getByText('Let in')).toBeOnTheScreen();
  });

  it('opens the meeting once Verity is in the call, without a pause it cannot honour', async () => {
    serve('joined');
    jest.mocked(listMeetings).mockResolvedValue([online()]);
    render(<MeetingScreen />);
    expect(await screen.findByLabelText('End meeting')).toBeOnTheScreen();
    expect(await screen.findByText('Microsoft Teams')).toBeOnTheScreen();
    // In the call but not transcribing yet: never "Joining…" once the bot is in.
    expect(screen.getByText('Starting transcript…')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Pause meeting')).toBeNull();
    expect(screen.queryByText('Joining the call')).toBeNull();
  });

  it('says why Verity could not join and offers to start again', async () => {
    serve('failed', 'login_required');
    jest
      .mocked(listMeetings)
      .mockResolvedValue([
        online({ state: 'ended', endedAt: Date.now(), captureStatus: 'preparing' }),
      ]);
    jest
      .mocked(useLocalSearchParams)
      .mockReturnValue({ sessionId: 'session-1', meetingId: 'online-1' });
    render(<MeetingScreen />);
    expect(await screen.findByText('Could not join')).toBeOnTheScreen();
    expect(screen.getByText('The meeting requires sign-in.')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByLabelText('Start meeting')).toBeOnTheScreen();
  });

  // Kept for good, the failure screen would hide discard and assign for that meeting.
  it('opens an older failed join as a finished meeting', async () => {
    serve('failed', 'login_required');
    jest
      .mocked(listMeetings)
      .mockResolvedValue([online({ state: 'ended', endedAt: Date.now() - 3_600_000 })]);
    jest
      .mocked(useLocalSearchParams)
      .mockReturnValue({ sessionId: 'session-1', meetingId: 'online-1' });
    render(<MeetingScreen />);
    await waitFor(() => expect(screen.queryByText('Could not join')).toBeNull());
    expect((await screen.findAllByLabelText('Meeting actions')).length).toBeGreaterThan(0);
  });

  // Each tap used to send another stop request while the bot was leaving.
  it('ends an online meeting once however often End is tapped', async () => {
    const client = serve('joined');
    jest.mocked(listMeetings).mockResolvedValue([online({ transcript: 'Hello' })]);
    render(<MeetingScreen />);
    const end = await screen.findByLabelText('End meeting');
    await act(async () => fireEvent.press(end));
    await act(async () => fireEvent.press(screen.getByLabelText('End meeting')));
    expect(client.stopOnlineMeeting).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Ending…').length).toBeGreaterThan(0);
  });

  it('keeps End available and says so when ending fails', async () => {
    const client = serve('joined', null, {
      stopOnlineMeeting: jest
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(undefined),
    });
    jest.mocked(listMeetings).mockResolvedValue([online({ transcript: 'Hello' })]);
    render(<MeetingScreen />);
    const end = await screen.findByLabelText('End meeting', {}, { timeout: 5000 });
    await act(async () => fireEvent.press(end));
    expect(await screen.findByText('Could not end')).toBeOnTheScreen();
    // The reason comes first: some failures need a reconnect rather than another tap.
    expect(screen.getByText('offline Tap End to try again.')).toBeOnTheScreen();
    await act(async () => fireEvent.press(screen.getByLabelText('End meeting')));
    expect(client.stopOnlineMeeting).toHaveBeenCalledTimes(2);
  });

  it('refuses a link Verity cannot join at the field, before starting anything', async () => {
    const client = serve('joining', null, { startOnlineMeeting: jest.fn() });
    render(<MeetingScreen />);
    fireEvent.press(await screen.findByText('Online meeting'));
    fireEvent.changeText(
      await screen.findByLabelText('Online meeting link'),
      'https://meet.example.com/product-planning',
    );
    await waitFor(() => expect(screen.getByLabelText('Start meeting')).toBeEnabled());
    await act(async () => fireEvent.press(screen.getByLabelText('Start meeting')));
    expect(await screen.findByText('Link not supported')).toBeOnTheScreen();
    expect(client.startOnlineMeeting).not.toHaveBeenCalled();
    fireEvent.changeText(
      screen.getByLabelText('Online meeting link'),
      'meet.google.com/abc-defg-hij',
    );
    expect(screen.queryByText('Link not supported')).toBeNull();
  });
});
