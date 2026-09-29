import { createVerityClient } from './client';
import { waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { currentMeeting, endMeeting } from './liveMeetingSession';
import {
  acknowledgeMeeting,
  acknowledgeNote,
  getSyncCursor,
  hasPendingMeetingSync,
  importChanges,
  pendingMeetings,
  pendingNotes,
} from './liveMeetingStore';
import { startLiveMeetingSync, syncMeetingSession } from './liveMeetingSync';

jest.mock('./client', () => ({ createVerityClient: jest.fn() }));
jest.mock('./liveMeetingSession', () => ({
  currentMeeting: jest.fn().mockReturnValue(null),
  endMeeting: jest.fn().mockResolvedValue(undefined),
  pauseMeeting: jest.fn().mockResolvedValue(undefined),
  resumeMeeting: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./liveMeetingStore', () => ({
  acknowledgeMeeting: jest.fn().mockResolvedValue(undefined),
  acknowledgeNote: jest.fn().mockResolvedValue(undefined),
  getSyncCursor: jest.fn().mockResolvedValue(0),
  hasPendingMeetingSync: jest.fn().mockResolvedValue(false),
  importChanges: jest.fn().mockResolvedValue(undefined),
  pendingMeetings: jest.fn().mockResolvedValue([]),
  pendingNotes: jest.fn().mockResolvedValue([]),
}));

const client = {
  putLiveMeeting: jest.fn().mockResolvedValue(undefined),
  putLiveMeetingNote: jest.fn().mockResolvedValue(undefined),
  getLiveMeetingChanges: jest.fn().mockResolvedValue({ cursor: 3, meetings: [], notes: [] }),
  getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
  acknowledgeLiveMeetingCommand: jest.fn().mockResolvedValue(undefined),
};
const meeting = {
  id: 'meeting-1',
  sessionId: 'session-1',
  engine: 'fluid-nemotron' as const,
  startedAt: 1,
  endedAt: null,
  state: 'active' as const,
  transcript: 'Words',
  captureStatus: 'listening' as const,
  ownerToken: 'owner-token',
  revision: 4,
};
const note = { id: 'note-1', meetingId: meeting.id, atSeconds: 2, text: 'Decision', revision: 3 };

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(createVerityClient)
    .mockReturnValue(client as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  jest.mocked(pendingMeetings).mockResolvedValue([]);
  jest.mocked(pendingNotes).mockResolvedValue([]);
  client.putLiveMeeting.mockResolvedValue(undefined);
  client.putLiveMeetingNote.mockResolvedValue(undefined);
  jest.mocked(currentMeeting).mockReturnValue(null);
});

it('does not apply a fetched command after the recording has changed', async () => {
  const oldRecording = { ...meeting, error: null };
  const newRecording = { ...oldRecording, id: 'meeting-2' };
  jest.mocked(currentMeeting).mockReturnValue(oldRecording);
  let deliver!: (result: { commands: unknown[]; recorderOnline: boolean }) => void;
  client.getLiveMeetingCommands.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const subscription = jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);
  const stop = startLiveMeetingSync();
  try {
    await waitFor(() =>
      expect(client.getLiveMeetingCommands).toHaveBeenCalledWith(
        'session-1',
        meeting.id,
        meeting.ownerToken,
      ),
    );
    jest.mocked(currentMeeting).mockReturnValue(newRecording);
    deliver({
      commands: [
        {
          id: 'command-1',
          meetingId: meeting.id,
          action: 'stop',
          state: 'pending',
          error: null,
          requestedAt: 1,
          acknowledgedAt: null,
        },
      ],
      recorderOnline: true,
    });
    await waitFor(() =>
      expect(client.acknowledgeLiveMeetingCommand).toHaveBeenCalledWith(
        'session-1',
        meeting.id,
        'command-1',
        meeting.ownerToken,
        'failed',
        expect.stringContaining('Recording changed'),
      ),
    );
    expect(endMeeting).not.toHaveBeenCalled();
  } finally {
    stop();
    subscription.mockRestore();
  }
});

it('uploads the meeting before its notes and acknowledges only the sent revisions', async () => {
  jest.mocked(pendingMeetings).mockResolvedValue([meeting]);
  jest.mocked(pendingNotes).mockResolvedValue([{ sessionId: 'session-1', note }]);
  const result = await syncMeetingSession('session-1');
  expect(result).toEqual({ pending: false });
  expect(client.putLiveMeeting).toHaveBeenCalledWith(meeting);
  expect(client.putLiveMeetingNote).toHaveBeenCalledWith('session-1', note);
  expect(client.putLiveMeeting.mock.invocationCallOrder[0]).toBeLessThan(
    client.putLiveMeetingNote.mock.invocationCallOrder[0]!,
  );
  expect(acknowledgeMeeting).toHaveBeenCalledWith(meeting.id, 4);
  expect(acknowledgeNote).toHaveBeenCalledWith(note.id, 3);
  expect(getSyncCursor).toHaveBeenCalledWith('session-1');
  expect(importChanges).toHaveBeenCalledWith('session-1', 3, [], []);
  expect(hasPendingMeetingSync).toHaveBeenCalledWith('session-1');
});

it('keeps an unsent revision pending while still receiving remote changes', async () => {
  jest.mocked(pendingMeetings).mockResolvedValue([meeting]);
  client.putLiveMeeting.mockRejectedValueOnce(new Error('offline'));
  expect(await syncMeetingSession('session-1')).toEqual({ pending: true });
  expect(acknowledgeMeeting).not.toHaveBeenCalled();
  expect(importChanges).toHaveBeenCalledWith('session-1', 3, [], []);
  expect(await syncMeetingSession('session-1')).toEqual({ pending: false });
  expect(acknowledgeMeeting).toHaveBeenCalledWith(meeting.id, 4);
});
