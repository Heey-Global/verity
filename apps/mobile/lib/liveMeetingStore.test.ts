import { waitFor } from '@testing-library/react-native';
import { listMeetings, saveNote } from './liveMeetingStore';

const mockRunAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn().mockResolvedValue({
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: mockRunAsync,
    getAllAsync: jest.fn().mockResolvedValue([]),
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
