jest.mock('./liveConnection', () => ({ subscribeLiveRefresh: () => () => {} }));
import { createVerityClient, getActiveMeetingServerId } from './client';
import { waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { currentMeeting, endMeeting, releaseMeeting } from './liveMeetingSession';
import {
  acknowledgeMeeting,
  acknowledgeNote,
  deleteMeeting,
  getSyncCursor,
  hasPendingMeetingSync,
  importChanges,
  pendingMeetings,
  pendingNotes,
  meetingUploadFailure,
  saveMeetingUploadFailure,
  clearMeetingUploadFailure,
} from './liveMeetingStore';
import { VerityApiError } from '@verity/mobile';
import {
  discardFinishedMeeting,
  startLiveMeetingSync,
  syncMeetingSession,
  getMeetingSyncFailure,
  retryMeetingSync,
  finalizeMeetingOnServer,
} from './liveMeetingSync';

jest.mock('./client', () => ({
  createVerityClient: jest.fn(),
  getActiveMeetingServerId: jest.fn().mockReturnValue('server-1'),
  subscribeVerityBaseUrl: () => () => {},
}));
jest.mock('./liveMeetingSession', () => ({
  currentMeeting: jest.fn().mockReturnValue(null),
  recoverNativeMeetings: jest.fn().mockResolvedValue(undefined),
  subscribeMeeting: () => () => {},
  endMeeting: jest.fn().mockResolvedValue(undefined),
  pauseMeeting: jest.fn().mockResolvedValue(undefined),
  releaseMeeting: jest.fn().mockReturnValue(true),
  resumeMeeting: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./liveMeetingStore', () => ({
  acknowledgeMeeting: jest.fn().mockResolvedValue(undefined),
  acknowledgeNote: jest.fn().mockResolvedValue(undefined),
  deleteMeeting: jest.fn().mockResolvedValue(undefined),
  getSyncCursor: jest.fn().mockResolvedValue(0),
  hasPendingMeetingSync: jest.fn().mockResolvedValue(false),
  importChanges: jest.fn().mockResolvedValue(undefined),
  pendingMeetings: jest.fn().mockResolvedValue([]),
  pendingNotes: jest.fn().mockResolvedValue([]),
  meetingUploadFailure: jest.fn().mockResolvedValue(null),
  saveMeetingUploadFailure: jest.fn().mockResolvedValue(undefined),
  clearMeetingUploadFailure: jest.fn().mockResolvedValue(undefined),
}));

const client = {
  putLiveMeeting: jest.fn().mockResolvedValue(undefined),
  putLiveMeetingNote: jest.fn().mockResolvedValue(undefined),
  getLiveMeetingChanges: jest
    .fn()
    .mockResolvedValue({ cursor: 3, meetings: [], notes: [], deletedMeetingIds: [] }),
  discardSessionMeeting: jest.fn().mockResolvedValue(undefined),
  getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
  acknowledgeLiveMeetingCommand: jest.fn().mockResolvedValue(undefined),
  finalizeLiveMeeting: jest.fn().mockResolvedValue(undefined),
};
const meeting = {
  id: 'meeting-1',
  sessionId: 'session-1',
  serverId: 'server-1',
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
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
  jest.mocked(meetingUploadFailure).mockResolvedValue(null);
  jest.mocked(saveMeetingUploadFailure).mockResolvedValue(undefined);
  client.finalizeLiveMeeting.mockResolvedValue(undefined);
  client.getLiveMeetingCommands.mockResolvedValue({ commands: [], recorderOnline: true });
});

it('keeps a rejected revision locally and suppresses its retry after restoring persisted failure state', async () => {
  jest.mocked(pendingMeetings).mockResolvedValue([meeting]);
  client.putLiveMeeting.mockRejectedValueOnce(new VerityApiError(400, 'invalid update'));
  expect(await syncMeetingSession('session-1')).toEqual({ pending: true });
  expect(saveMeetingUploadFailure).toHaveBeenCalledWith('server-1', meeting.id, {
    revision: 4,
    status: 400,
    serverFinalized: false,
  });
  jest
    .mocked(meetingUploadFailure)
    .mockResolvedValue({ revision: 4, status: 400, serverFinalized: false });
  expect(await syncMeetingSession('session-1')).toEqual({ pending: true });
  expect(client.putLiveMeeting).toHaveBeenCalledTimes(1);
  expect(acknowledgeMeeting).not.toHaveBeenCalled();
  expect(getMeetingSyncFailure('server-1', meeting.id)?.status).toBe(400);
  expect(deleteMeeting).not.toHaveBeenCalled();
});

it('keeps new revisions pending until explicit retry after a permanent validation failure', async () => {
  jest.mocked(pendingMeetings).mockResolvedValue([{ ...meeting, revision: 5 }]);
  jest
    .mocked(meetingUploadFailure)
    .mockResolvedValue({ revision: 4, status: 400, serverFinalized: false });
  await syncMeetingSession('session-1');
  expect(client.putLiveMeeting).not.toHaveBeenCalled();
  expect(acknowledgeMeeting).not.toHaveBeenCalled();
  expect(clearMeetingUploadFailure).not.toHaveBeenCalled();
});

it('finalizes server state without discarding or acknowledging the unsent transcript', async () => {
  jest
    .mocked(meetingUploadFailure)
    .mockResolvedValue({ revision: 4, status: 400, serverFinalized: false });
  await finalizeMeetingOnServer('session-1', meeting.id);
  expect(client.finalizeLiveMeeting).toHaveBeenCalledWith('session-1', meeting.id);
  expect(saveMeetingUploadFailure).toHaveBeenCalledWith('server-1', meeting.id, {
    revision: 4,
    status: 400,
    serverFinalized: true,
  });
  expect(acknowledgeMeeting).not.toHaveBeenCalled();
  expect(deleteMeeting).not.toHaveBeenCalled();
});

it('allows an explicit retry while preserving confirmed server finalization', async () => {
  jest.mocked(pendingMeetings).mockResolvedValue([meeting]);
  let stored = { revision: 4, status: 400, serverFinalized: true };
  jest.mocked(meetingUploadFailure).mockImplementation(async () => stored);
  jest.mocked(saveMeetingUploadFailure).mockImplementation(async (_server, _id, failure) => {
    stored = failure;
  });
  await retryMeetingSync('session-1', meeting.id);
  expect(saveMeetingUploadFailure).toHaveBeenCalledWith('server-1', meeting.id, {
    revision: -1,
    status: 400,
    serverFinalized: true,
  });
  expect(client.putLiveMeeting).toHaveBeenCalled();
  expect(deleteMeeting).not.toHaveBeenCalled();
});

it('acknowledges a remote stop using server finalization when the final transcript is rejected', async () => {
  const stopped = { ...meeting, state: 'ended' as const, endedAt: 2 };
  jest.mocked(currentMeeting).mockReturnValue({ ...meeting, error: null });
  jest.mocked(pendingMeetings).mockResolvedValue([stopped]);
  client.putLiveMeeting.mockRejectedValue(new VerityApiError(400, 'invalid update'));
  client.getLiveMeetingCommands.mockResolvedValueOnce({
    commands: [
      {
        id: 'stop-1',
        action: 'stop',
        state: 'pending',
      },
    ],
    recorderOnline: true,
  });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const subscription = jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() });
  const stop = startLiveMeetingSync();
  try {
    await waitFor(() =>
      expect(client.acknowledgeLiveMeetingCommand).toHaveBeenCalledWith(
        'session-1',
        meeting.id,
        'stop-1',
        meeting.ownerToken,
        'completed',
        null,
      ),
    );
    expect(endMeeting).toHaveBeenCalled();
    expect(client.finalizeLiveMeeting).toHaveBeenCalledWith('session-1', meeting.id);
    expect(acknowledgeMeeting).not.toHaveBeenCalled();
  } finally {
    stop();
    subscription.mockRestore();
  }
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
  expect(acknowledgeMeeting).toHaveBeenCalledWith('server-1', meeting.id, 4);
  expect(acknowledgeNote).toHaveBeenCalledWith('server-1', note.id, 3);
  expect(getSyncCursor).toHaveBeenCalledWith('server-1', 'session-1');
  expect(importChanges).toHaveBeenCalledWith('server-1', 'session-1', 3, [], [], []);
  expect(hasPendingMeetingSync).toHaveBeenCalledWith('server-1', 'session-1');
});

it('keeps an unsent revision pending while still receiving remote changes', async () => {
  jest.mocked(pendingMeetings).mockResolvedValue([meeting]);
  client.putLiveMeeting.mockRejectedValueOnce(new Error('offline'));
  expect(await syncMeetingSession('session-1')).toEqual({ pending: true });
  expect(acknowledgeMeeting).not.toHaveBeenCalled();
  expect(importChanges).toHaveBeenCalledWith('server-1', 'session-1', 3, [], [], []);
  expect(await syncMeetingSession('session-1')).toEqual({ pending: false });
  expect(acknowledgeMeeting).toHaveBeenCalledWith('server-1', meeting.id, 4);
});

it('does not upload or apply recorder commands after switching servers', async () => {
  jest
    .mocked(pendingMeetings)
    .mockImplementation(async (serverId) => (serverId === 'server-1' ? [meeting] : []));
  jest
    .mocked(pendingNotes)
    .mockImplementation(async (serverId) =>
      serverId === 'server-1' ? [{ sessionId: 'session-1', note }] : [],
    );
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-2');
  await syncMeetingSession('session-1');
  expect(pendingMeetings).toHaveBeenCalledWith('server-2');
  expect(pendingNotes).toHaveBeenCalledWith('server-2');
  expect(client.putLiveMeeting).not.toHaveBeenCalled();
  expect(client.putLiveMeetingNote).not.toHaveBeenCalled();
  expect(getSyncCursor).toHaveBeenCalledWith('server-2', 'session-1');
  expect(importChanges).toHaveBeenCalledWith('server-2', 'session-1', 3, [], [], []);

  jest.mocked(currentMeeting).mockReturnValue({ ...meeting, error: null });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const subscription = jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);
  const stop = startLiveMeetingSync();
  try {
    await waitFor(() => expect(pendingMeetings).toHaveBeenCalledWith('server-2'));
    expect(client.getLiveMeetingCommands).not.toHaveBeenCalled();
  } finally {
    stop();
    subscription.mockRestore();
  }
});

it('uploads a viewing device note without a local recording or a new transcript event', async () => {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const subscription = jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() });
  jest.mocked(currentMeeting).mockReturnValue(null);
  jest.mocked(getActiveMeetingServerId).mockReturnValue('web:https://browser.test');
  jest.mocked(pendingMeetings).mockResolvedValue([]);
  jest.mocked(pendingNotes).mockResolvedValue([{ sessionId: 'session-1', note }]);
  const stop = startLiveMeetingSync();
  try {
    await waitFor(() => expect(client.putLiveMeetingNote).toHaveBeenCalledWith('session-1', note));
    expect(acknowledgeNote).toHaveBeenCalledWith(
      'web:https://browser.test',
      note.id,
      note.revision,
    );
    expect(client.putLiveMeeting).not.toHaveBeenCalled();
    expect(client.getLiveMeetingCommands).not.toHaveBeenCalled();
    expect(endMeeting).not.toHaveBeenCalled();
  } finally {
    stop();
    subscription.mockRestore();
  }
});

it('passes meetings discarded on another device to the local store', async () => {
  client.getLiveMeetingChanges.mockResolvedValueOnce({
    cursor: 9,
    meetings: [],
    notes: [],
    deletedMeetingIds: ['meeting-1'],
  });
  await syncMeetingSession('session-1');
  expect(importChanges).toHaveBeenCalledWith('server-1', 'session-1', 9, [], [], ['meeting-1']);
  expect(releaseMeeting).not.toHaveBeenCalled();
});

it('lets go of a finished meeting discarded on another device', async () => {
  jest.mocked(currentMeeting).mockReturnValue({ ...meeting, state: 'ended', error: null });
  client.getLiveMeetingChanges.mockResolvedValueOnce({
    cursor: 9,
    meetings: [],
    notes: [],
    deletedMeetingIds: ['meeting-1'],
  });
  await syncMeetingSession('session-1');
  expect(releaseMeeting).toHaveBeenCalledWith('meeting-1');
});

// A finished recording answered 404 on /commands after it was discarded, every few seconds.
it('polls recorder commands only until the recording has ended', async () => {
  jest.mocked(currentMeeting).mockReturnValue({ ...meeting, state: 'ended', error: null });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const subscription = jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);
  const stop = startLiveMeetingSync();
  try {
    const { recoverNativeMeetings } = jest.requireMock('./liveMeetingSession');
    // The sync loop has ticked: native recovery runs first and resolves into the tick.
    await waitFor(() => expect(recoverNativeMeetings).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.getLiveMeetingCommands).not.toHaveBeenCalled();
  } finally {
    stop();
    subscription.mockRestore();
  }
});

// Without this, a recorder holding an unsent revision would retry the refused upload on
// every sync and report the meeting as pending forever.
it('drops a pending meeting the server reports as discarded', async () => {
  jest.mocked(pendingMeetings).mockResolvedValue([meeting]);
  client.putLiveMeeting.mockRejectedValueOnce(
    new VerityApiError(409, 'This meeting was discarded.', { code: 'meeting_deleted' }),
  );
  expect(await syncMeetingSession('session-1')).toEqual({ pending: false });
  expect(deleteMeeting).toHaveBeenCalledWith(meeting.id, 'server-1');
  expect(acknowledgeMeeting).not.toHaveBeenCalled();
});

it('keeps a pending meeting on other upload conflicts', async () => {
  jest.mocked(pendingMeetings).mockResolvedValue([meeting]);
  client.putLiveMeeting.mockRejectedValueOnce(new VerityApiError(409, 'owner mismatch'));
  expect(await syncMeetingSession('session-1')).toEqual({ pending: true });
  expect(deleteMeeting).not.toHaveBeenCalled();
});

describe('discardFinishedMeeting', () => {
  const ended = { ...meeting, state: 'ended' as const };

  it('deletes on the server before deleting the local copy', async () => {
    await discardFinishedMeeting('session-1', ended, client as never);
    expect(client.discardSessionMeeting).toHaveBeenCalledWith('session-1', meeting.id);
    expect(deleteMeeting).toHaveBeenCalledWith(meeting.id, 'server-1');
    // The app kept polling a discarded meeting for 15 minutes and more: it stayed current.
    expect(releaseMeeting).toHaveBeenCalledWith(meeting.id);
    expect(client.discardSessionMeeting.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(deleteMeeting).mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the local copy when the server refuses', async () => {
    client.discardSessionMeeting.mockRejectedValueOnce(new VerityApiError(503, 'unavailable'));
    await expect(discardFinishedMeeting('session-1', ended, client as never)).rejects.toThrow(
      'unavailable',
    );
    expect(deleteMeeting).not.toHaveBeenCalled();
    expect(releaseMeeting).not.toHaveBeenCalled();
  });

  it('deletes locally when the server no longer has the meeting', async () => {
    client.discardSessionMeeting.mockRejectedValueOnce(
      new VerityApiError(404, 'meeting not found', { code: 'meeting_not_found' }),
    );
    await discardFinishedMeeting('session-1', ended, client as never);
    expect(deleteMeeting).toHaveBeenCalledWith(meeting.id, 'server-1');
  });

  // An older server answers 404 for the unknown route; deleting locally then would lose
  // the only copy of unsent changes while the server keeps the meeting.
  it('keeps the local copy for any other 404', async () => {
    client.discardSessionMeeting.mockRejectedValueOnce(new VerityApiError(404, 'Not Found'));
    await expect(discardFinishedMeeting('session-1', ended, client as never)).rejects.toThrow();
    expect(deleteMeeting).not.toHaveBeenCalled();
  });

  it('deletes a meeting saved only on this device without the server', async () => {
    await discardFinishedMeeting('session-1', { ...ended, serverId: null }, client as never);
    expect(client.discardSessionMeeting).not.toHaveBeenCalled();
    expect(deleteMeeting).toHaveBeenCalledWith(meeting.id, null);
  });

  it('refuses a running meeting or one from another server', async () => {
    await expect(discardFinishedMeeting('session-1', meeting, client as never)).rejects.toThrow(
      'End the meeting',
    );
    await expect(
      discardFinishedMeeting('session-1', { ...ended, serverId: 'server-2' }, client as never),
    ).rejects.toThrow('Reconnect');
    // An online meeting that is still recovering is not finished yet.
    await expect(
      discardFinishedMeeting(
        'session-1',
        { ...ended, state: 'interrupted', engine: 'attendee' },
        client as never,
      ),
    ).rejects.toThrow('End the meeting');
    expect(client.discardSessionMeeting).not.toHaveBeenCalled();
    expect(deleteMeeting).not.toHaveBeenCalled();
  });
});
