import { DatabaseSync, type SQLInputValue, type StatementResultingChanges } from 'node:sqlite';
import {
  createMeeting,
  listMeetings,
  nativeMeetingState,
  persistNativeMeetingEvent,
  persistRecoveredAudio,
  setMeetingState,
  saveSpeakerEdits,
} from './liveMeetingStore';
import type { STTEvent } from './liveMeetingSTT';
import { liveMeetingSTT } from './liveMeetingSTT';
import {
  currentMeeting,
  startMeeting,
  endMeeting,
  recoverMeetingAudio,
  recoverNativeMeetings,
} from './liveMeetingSession';
import { waitFor } from '@testing-library/react-native';

const mockObserve = jest.fn();
const mockPause = jest.fn();
jest.mock('./liveMeetingVoice', () => ({
  VoiceMeetingCommandDetector: jest.fn().mockImplementation(() => ({
    observe: mockObserve,
    pause: mockPause,
    stop: jest.fn(),
  })),
}));

jest.mock('./client', () => ({
  getActiveMeetingServerId: () => 'server-1',
  getVerityBaseUrl: () => 'https://example.test',
  createVerityClient: () => null,
}));
jest.mock('./demoMode', () => ({ isDemoMode: () => false, isEnteringDemoMode: () => false }));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: async () => new Uint8Array(32).fill(1) }));
let mockListener: ((event: STTEvent) => void) | undefined;
let mockJournal: Array<{ meetingId: string; sequence: number; event: STTEvent }> = [];
function mockDeliver(event: STTEvent & { journalMeetingId: string; journalSequence: number }) {
  mockJournal.push({ meetingId: event.journalMeetingId, sequence: event.journalSequence, event });
  mockListener!(event);
}
jest.mock('./liveMeetingSTT', () => ({
  liveMeetingSTT: {
    engines: async () => [{ id: 'apple-speech', available: true }],
    configureMeeting: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    acknowledgeMeetingJournal: jest.fn(async (id: string, through: number) => {
      mockJournal = mockJournal.filter(
        (entry) => entry.meetingId !== id || entry.sequence > through,
      );
    }),
    currentCapture: jest.fn().mockResolvedValue(null),
    journalMeetings: jest.fn().mockResolvedValue([]),
    readMeetingJournal: jest.fn(async (id: string, after: number, limit: number) =>
      mockJournal
        .filter((entry) => entry.meetingId === id && entry.sequence > after)
        .slice(0, limit),
    ),
    recoverAudioBuffer: jest.fn().mockResolvedValue([]),
    acknowledgeAudioRecovery: jest.fn().mockResolvedValue(undefined),
    addListener: (_event: string, listener: (event: STTEvent) => void) => {
      mockListener = listener;
      return { remove: () => {} };
    },
  },
}));
const mockDatabase = new DatabaseSync(':memory:');
let mockFailUpdate = false;
let mockFailRecovery = false;
interface TestConnection {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...args: SQLInputValue[]): Promise<StatementResultingChanges>;
  getFirstAsync(sql: string, ...args: SQLInputValue[]): Promise<unknown>;
  getAllAsync(sql: string, ...args: SQLInputValue[]): Promise<unknown[]>;
  withExclusiveTransactionAsync(
    body: (transaction: TestConnection) => Promise<void>,
  ): Promise<void>;
}
const mockConnection: TestConnection = {
  execAsync: async (sql: string) => {
    mockDatabase.exec(sql);
  },
  runAsync: async (sql: string, ...args: SQLInputValue[]) => {
    if (mockFailUpdate && sql.includes('SET native_state')) throw new Error('disk full');
    if (mockFailRecovery && sql.startsWith('UPDATE meetings SET transcript'))
      throw new Error('recovery disk full');
    return mockDatabase.prepare(sql).run(...args);
  },
  getFirstAsync: async (sql: string, ...args: SQLInputValue[]) =>
    mockDatabase.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: SQLInputValue[]) =>
    mockDatabase.prepare(sql).all(...args),
  withExclusiveTransactionAsync: async (
    body: (transaction: typeof mockConnection) => Promise<void>,
  ) => {
    mockDatabase.exec('BEGIN IMMEDIATE');
    try {
      await body(mockConnection);
      mockDatabase.exec('COMMIT');
    } catch (error) {
      mockDatabase.exec('ROLLBACK');
      throw error;
    }
  },
};
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: async () => mockConnection }));

function event(meetingId: string, sequence: number, body: STTEvent) {
  return persistNativeMeetingEvent({ meetingId, sequence, event: body });
}

afterAll(() => mockDatabase.close());

it('atomically persists audio-range state and cursor, retrying a failed commit without duplicates', async () => {
  const meeting = await createMeeting('native-session', 'apple-speech');
  const phrase: STTEvent = { kind: 'segment', text: 'First phrase', final: true, start: 0, end: 2 };
  mockFailUpdate = true;
  await expect(event(meeting.id, 1, phrase)).rejects.toThrow('disk full');
  expect(await nativeMeetingState(meeting.id)).toBeNull();
  mockFailUpdate = false;
  await event(meeting.id, 1, phrase);
  const revision = (await listMeetings('native-session'))[0]!.revision;
  await event(meeting.id, 1, phrase);
  expect((await nativeMeetingState(meeting.id))?.sequence).toBe(1);
  const restored = (await listMeetings('native-session'))[0]!;
  expect(restored.transcript).toBe('First phrase');
  expect(restored.timedWords).toHaveLength(1);
  expect(restored.revision).toBe(revision);
});

it('restores compacted snapshots and new words without changing meeting identity, notes or speaker edits', async () => {
  const meeting = await createMeeting('compact-session', 'fluid-nemotron');
  await saveSpeakerEdits(meeting.id, { '0': 'Anna' }, [{ start: 0, end: 1, speaker: 0 }], {});
  await event(meeting.id, 3, { kind: 'snapshot', text: 'Complete earlier speech', final: false });
  await event(meeting.id, 5, { kind: 'words', words: [{ text: 'Complete', start: 0, end: 1 }] });
  await event(meeting.id, 6, {
    kind: 'snapshot',
    text: 'Complete earlier speech and more',
    final: true,
  });
  const restored = (await listMeetings('compact-session'))[0]!;
  expect(restored.id).toBe(meeting.id);
  expect(restored.ownerToken).toBe(meeting.ownerToken);
  expect(restored.speakerNames).toEqual({ '0': 'Anna' });
  expect(restored.speakerCorrections).toEqual([{ start: 0, end: 1, speaker: 0 }]);
  expect(restored.transcript).toBe('Complete earlier speech and more');
});

it('keeps recovery idempotent if deletion acknowledgement is interrupted', async () => {
  const meeting = await createMeeting('recovery-session', 'fluid-parakeet');
  await event(meeting.id, 1, { kind: 'snapshot', text: 'Saved original', final: true });
  await setMeetingState(meeting.id, 'interrupted');
  const segments = [{ id: 'audio-1', text: 'Recovered ending', start: 30, end: 40 }];
  await persistRecoveredAudio(meeting.id, segments);
  await persistRecoveredAudio(meeting.id, segments);
  const restored = (await listMeetings('recovery-session'))[0]!;
  expect(restored.transcript).toBe(
    'Saved original\n\n[Recovered audio 30.0–40.0s]\nRecovered ending',
  );
});

it('refuses unknown native owners and recovery during active capture', async () => {
  await expect(
    event('unknown', 1, { kind: 'snapshot', text: 'Other', final: true }),
  ).rejects.toThrow('owned local meeting');
  const meeting = await createMeeting('active-session', 'apple-speech');
  await expect(persistRecoveredAudio(meeting.id, [])).rejects.toThrow('End this local meeting');
});

it('persists native Lock Screen controls before acknowledging their journal and updates the open meeting', async () => {
  const meeting = await startMeeting('bridge-session', 'apple-speech', 4, 'Meeting', {
    audioSafetyBuffer: true,
  });
  expect(liveMeetingSTT!.configureMeeting).toHaveBeenCalledWith(
    meeting.id,
    meeting.sessionId,
    meeting.startedAt,
    true,
  );
  mockDeliver({
    journalMeetingId: meeting.id,
    journalSequence: 1,
    kind: 'segment',
    text: 'Locked screen speech',
    final: true,
    start: 0,
    end: 2,
  });
  mockDeliver({
    journalMeetingId: meeting.id,
    journalSequence: 2,
    kind: 'status',
    state: 'paused',
  });
  await waitFor(() => expect(currentMeeting()?.captureStatus).toBe('paused'));
  expect((await listMeetings('bridge-session'))[0]?.transcript).toBe('Locked screen speech');
  expect(liveMeetingSTT!.acknowledgeMeetingJournal).toHaveBeenCalledWith(meeting.id, 2);
  mockDeliver({
    journalMeetingId: meeting.id,
    journalSequence: 3,
    kind: 'status',
    state: 'stopped',
  });
  await waitFor(() => expect(currentMeeting()?.state).toBe('ended'));
  expect((await listMeetings('bridge-session'))[0]?.state).toBe('ended');
  await endMeeting();
});

it('does not delete saved audio when its recovered transcript could not commit', async () => {
  const meeting = await createMeeting('recovery-bridge', 'apple-speech');
  await setMeetingState(meeting.id, 'ended');
  jest
    .mocked(liveMeetingSTT!.recoverAudioBuffer!)
    .mockResolvedValueOnce([{ id: 'saved-audio', text: 'Kept words', start: 1, end: 2 }]);
  jest.mocked(liveMeetingSTT!.acknowledgeAudioRecovery!).mockClear();
  mockFailRecovery = true;
  await expect(recoverMeetingAudio(meeting.id)).rejects.toThrow('recovery disk full');
  mockFailRecovery = false;
  expect(liveMeetingSTT!.acknowledgeAudioRecovery).not.toHaveBeenCalled();
});

it('replays pending native results after a process exit without resurrecting recording', async () => {
  const meeting = await createMeeting('cold-recovery', 'apple-speech');
  await setMeetingState(meeting.id, 'interrupted');
  jest.mocked(liveMeetingSTT!.journalMeetings!).mockResolvedValueOnce([{ meetingId: meeting.id }]);
  jest.mocked(liveMeetingSTT!.readMeetingJournal!).mockResolvedValueOnce([
    {
      meetingId: meeting.id,
      sequence: 1,
      event: { kind: 'segment', text: 'Before process exit', final: true, start: 0, end: 2 },
    },
  ]);
  await recoverNativeMeetings();
  const saved = (await listMeetings('cold-recovery'))[0]!;
  expect(saved.transcript).toBe('Before process exit');
  expect(saved.state).toBe('interrupted');
  expect(liveMeetingSTT!.acknowledgeMeetingJournal).toHaveBeenCalledWith(meeting.id, 1);
});

it('drains more than 512 old events before acknowledging a newer live notification', async () => {
  const meeting = await startMeeting('long-backlog', 'apple-speech');
  mockJournal.push({
    meetingId: meeting.id,
    sequence: 1,
    event: {
      kind: 'segment',
      text: 'Speech saved before JavaScript woke up',
      final: true,
      start: 0,
      end: 1,
    },
  });
  for (let sequence = 2; sequence <= 600; sequence++) {
    mockJournal.push({
      meetingId: meeting.id,
      sequence,
      event: {
        kind: 'words',
        words: [{ text: `word${sequence}`, start: sequence, end: sequence + 0.5 }],
      },
    });
  }
  mockDeliver({
    journalMeetingId: meeting.id,
    journalSequence: 601,
    kind: 'health',
    microphone: 'running',
    transcription: 'listening',
    persistence: 'saved',
    audioSeconds: 601,
    lastAudioAt: Date.now(),
    lastTranscriptAt: Date.now(),
  });
  await waitFor(() => expect(currentMeeting()?.captureHealth?.audioSeconds).toBe(601), {
    timeout: 5000,
  });
  const state = await nativeMeetingState(meeting.id);
  expect(state?.sequence).toBe(601);
  expect(state?.words).toHaveLength(600);
  expect(currentMeeting()?.transcript).toBe('Speech saved before JavaScript woke up');
  expect(mockJournal.filter((entry) => entry.meetingId === meeting.id)).toEqual([]);
  await endMeeting();
});

it('does not resurrect a meeting ended from the Lock Screen during foreground replay', async () => {
  const meeting = await createMeeting('end-during-replay', 'apple-speech');
  await setMeetingState(meeting.id, 'interrupted');
  jest
    .mocked(liveMeetingSTT!.currentCapture!)
    .mockResolvedValueOnce({ meetingId: meeting.id, state: 'listening' })
    .mockResolvedValueOnce(null);
  jest.mocked(liveMeetingSTT!.journalMeetings!).mockResolvedValueOnce([{ meetingId: meeting.id }]);
  jest.mocked(liveMeetingSTT!.readMeetingJournal!).mockResolvedValueOnce([
    {
      meetingId: meeting.id,
      sequence: 1,
      event: { kind: 'status', state: 'stopped', recordedAt: 20_000 },
    },
  ]);
  await recoverNativeMeetings();
  const saved = (await listMeetings('end-during-replay'))[0]!;
  expect(saved.state).toBe('ended');
  expect(saved.endedAt).toBe(20_000);
  expect(currentMeeting()?.state).toBe('ended');
});

it('keeps native capture and its journal when the SQLite mirror is temporarily unavailable', async () => {
  const meeting = await startMeeting('locked-sqlite', 'apple-speech');
  const stops = jest.mocked(liveMeetingSTT!.stop).mock.calls.length;
  mockFailUpdate = true;
  mockDeliver({
    journalMeetingId: meeting.id,
    journalSequence: 1,
    kind: 'segment',
    text: 'Retained while locked',
    final: true,
    start: 0,
    end: 2,
  });
  await waitFor(() => expect(currentMeeting()?.error).toContain('results are pending'));
  expect(currentMeeting()?.state).toBe('active');
  expect(jest.mocked(liveMeetingSTT!.stop).mock.calls).toHaveLength(stops);
  expect(mockJournal.some((entry) => entry.meetingId === meeting.id && entry.sequence === 1)).toBe(
    true,
  );
  mockFailUpdate = false;
  mockDeliver({
    journalMeetingId: meeting.id,
    journalSequence: 2,
    kind: 'status',
    state: 'listening',
  });
  await waitFor(() => expect(currentMeeting()?.transcript).toBe('Retained while locked'));
  await endMeeting();
});

it('updates the current speaker from validated journaled tentative turns', async () => {
  const meeting = await startMeeting('tentative-journal', 'apple-speech');
  mockDeliver({
    journalMeetingId: meeting.id,
    journalSequence: 1,
    kind: 'speaker-tentative',
    through: 8,
    turns: [
      { speaker: 1, start: 1, end: 3 },
      { speaker: 2, start: 3, end: 7 },
      { speaker: 99, start: 7, end: 8 },
    ],
  });
  await waitFor(() => expect(currentMeeting()?.activeSpeaker).toBe(2));
  expect(currentMeeting()?.tentativeSpeakerTurns).toHaveLength(2);
  expect(currentMeeting()?.lastSpeakerAt).toEqual(expect.any(Number));
  await endMeeting();
});

it('restores command detection after replay without dispatching historical commands', async () => {
  const meeting = await createMeeting('restore-assistants', 'apple-speech');
  await setMeetingState(meeting.id, 'interrupted');
  jest
    .mocked(liveMeetingSTT!.currentCapture!)
    .mockResolvedValue({ meetingId: meeting.id, state: 'listening' });
  jest.mocked(liveMeetingSTT!.journalMeetings!).mockResolvedValueOnce([{ meetingId: meeting.id }]);
  mockJournal.push({
    meetingId: meeting.id,
    sequence: 1,
    event: {
      kind: 'segment',
      text: 'Verity, historical request.',
      final: true,
      start: 0,
      end: 2,
    },
  });
  mockPause.mockClear();
  mockObserve.mockClear();
  await recoverNativeMeetings();
  expect(mockPause).toHaveBeenCalledWith('Verity, historical request.');
  expect(mockObserve).not.toHaveBeenCalled();
  mockDeliver({
    journalMeetingId: meeting.id,
    journalSequence: 2,
    kind: 'segment',
    text: 'Verity, new request.',
    final: true,
    start: 2,
    end: 4,
  });
  await waitFor(() =>
    expect(mockObserve).toHaveBeenCalledWith(expect.stringContaining('new request'), true),
  );
  jest.mocked(liveMeetingSTT!.currentCapture!).mockResolvedValue(null);
  await endMeeting();
});
