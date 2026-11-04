import { waitFor } from '@testing-library/react-native';
import {
  deleteMeeting,
  importChanges,
  listMeetings,
  saveNote,
  saveSpeakerTurns,
  saveSpeakerEdits,
} from './liveMeetingStore';
jest.mock('./client', () => ({ getActiveMeetingServerId: jest.fn().mockReturnValue(null) }));

const mockRunAsync = jest.fn().mockResolvedValue(undefined);
const mockGetFirstAsync = jest.fn().mockResolvedValue(null);
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn().mockResolvedValue({
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: mockRunAsync,
    getAllAsync: jest.fn().mockResolvedValue([]),
    getFirstAsync: mockGetFirstAsync,
    withTransactionAsync: (task: () => Promise<void>) => task(),
  }),
}));

it('bounds a recovered meeting at its last persisted activity', async () => {
  await listMeetings('session-1');
  expect(mockRunAsync).toHaveBeenCalledWith(
    expect.stringMatching(
      /UPDATE meetings SET state = 'interrupted', ended_at = last_active_at.*WHERE state = 'active'/,
    ),
  );
});

it('writes edits to one note in call order across screen instances', async () => {
  await listMeetings('session-1');
  mockRunAsync.mockClear();
  let releaseFirst!: () => void;
  mockRunAsync.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
  );
  const note = { id: 'note-1', meetingId: 'meeting-1', atSeconds: 2, text: 'Old text' };
  const oldWrite = saveNote(note);
  await waitFor(() => expect(mockRunAsync).toHaveBeenCalledTimes(1));
  const newWrite = saveNote({ ...note, text: 'New text' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mockRunAsync).toHaveBeenCalledTimes(1);

  releaseFirst();
  await Promise.all([oldWrite, newWrite]);
  expect(mockRunAsync).toHaveBeenCalledTimes(2);
  expect(mockRunAsync.mock.calls[1].at(-1)).toBe('New text');
});

it('stores speaker turns with their original audio time ranges', async () => {
  await saveSpeakerTurns('meeting-1', [{ speaker: 2, start: 1.5, end: 2.25 }]);
  expect(mockRunAsync).toHaveBeenCalledWith(
    'UPDATE meetings SET speaker_turns = ?, revision = revision + 1 WHERE id = ?',
    '[{"speaker":2,"start":1.5,"end":2.25}]',
    'meeting-1',
  );
});

it('stores meeting-only speaker names and segment corrections on the owner device', async () => {
  await saveSpeakerEdits('meeting-1', { '0': 'Anna' }, [{ start: 1, end: 2, speaker: 1 }], {
    '2': 0,
  });
  expect(mockRunAsync).toHaveBeenCalledWith(
    expect.stringContaining('WHERE id = ? AND owner_token IS NOT NULL'),
    '{"0":"Anna"}',
    '[{"start":1,"end":2,"speaker":1}]',
    '{"2":0}',
    'meeting-1',
  );
});

const deletes = () =>
  mockRunAsync.mock.calls
    .filter(([statement]) => /^DELETE/.test(String(statement)))
    .map(([statement, id]) => [String(statement), id]);

it('deletes a discarded meeting with its notes and drafts', async () => {
  await listMeetings('session-1');
  mockRunAsync.mockClear();
  mockGetFirstAsync.mockResolvedValueOnce({ id: 'meeting-1' });
  await deleteMeeting('meeting-1');
  // Drafts are unfinalized rows of the same table, so one statement removes both.
  expect(deletes()).toEqual([
    ['DELETE FROM meeting_notes WHERE meeting_id = ?', 'meeting-1'],
    ['DELETE FROM meetings WHERE id = ?', 'meeting-1'],
  ]);
});

it('applies a remote discard only to the copy from that server', async () => {
  await listMeetings('session-1');
  mockRunAsync.mockClear();
  mockGetFirstAsync.mockImplementation(async (statement: string, ...args: unknown[]) =>
    statement.includes('server_id = ?') && args[1] === 'server-1' && args[0] === 'shared'
      ? { id: 'shared' }
      : null,
  );
  await importChanges('server-1', 'session-1', 5, [], [], ['shared', 'other-server']);
  mockGetFirstAsync.mockReset();
  mockGetFirstAsync.mockResolvedValue(null);
  // The other server's meeting row and notes stay; only notes without any meeting may go.
  expect(deletes()).toEqual([
    ['DELETE FROM meeting_notes WHERE meeting_id = ?', 'shared'],
    ['DELETE FROM meetings WHERE id = ?', 'shared'],
    [expect.stringContaining('NOT EXISTS (SELECT 1 FROM meetings WHERE id = ?)'), 'other-server'],
  ]);
});

it('removes notes left behind by a meeting that is already gone', async () => {
  await listMeetings('session-1');
  mockRunAsync.mockClear();
  mockGetFirstAsync.mockResolvedValueOnce(null);
  await deleteMeeting('meeting-gone', 'server-1');
  expect(deletes()).toEqual([
    [
      'DELETE FROM meeting_notes WHERE meeting_id = ? AND NOT EXISTS (SELECT 1 FROM meetings WHERE id = ?)',
      'meeting-gone',
    ],
  ]);
});
