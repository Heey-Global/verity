import { liveMeetingSTT, type STTEvent } from './liveMeetingSTT';
import { waitFor } from '@testing-library/react-native';
import { createMeeting, saveTranscript, setMeetingState } from './liveMeetingStore';
import { currentMeeting, endMeeting, startMeeting } from './liveMeetingSession';

jest.mock('./liveMeetingSTT', () => ({
  liveMeetingSTT: {
    engines: jest.fn().mockResolvedValue([{ id: 'fluid-nemotron', available: true }]),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    addListener: jest.fn(),
  },
}));

jest.mock('./liveMeetingStore', () => ({
  createMeeting: jest.fn().mockResolvedValue({
    id: 'meeting-1',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: 1,
    endedAt: null,
    state: 'active',
    transcript: '',
    error: null,
  }),
  saveTranscript: jest.fn().mockResolvedValue(undefined),
  setMeetingState: jest.fn().mockResolvedValue(undefined),
  touchMeeting: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => jest.clearAllMocks());

it('persists a Nemotron transcript and final text before ending the meeting', async () => {
  const native = liveMeetingSTT!;
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(native.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  jest.mocked(native.stop).mockImplementation(async () => {
    onEvent({ kind: 'snapshot', text: 'Complete meeting text', final: true });
  });

  await startMeeting('session-1');
  expect(createMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron');
  expect(jest.mocked(createMeeting).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(native.start).mock.invocationCallOrder[0],
  );
  expect(native.start).toHaveBeenCalledWith('fluid-nemotron', 'de-DE', ['Verity']);

  onEvent({ kind: 'snapshot', text: 'Complete meeting', final: false });
  await endMeeting();

  expect(saveTranscript).toHaveBeenLastCalledWith('meeting-1', 'Complete meeting text');
  expect(jest.mocked(saveTranscript).mock.invocationCallOrder.at(-1)).toBeLessThan(
    jest.mocked(setMeetingState).mock.invocationCallOrder[0],
  );
  expect(setMeetingState).toHaveBeenLastCalledWith('meeting-1', 'ended');
});

it('stops reporting recording even when both state writes fail after capture stops', async () => {
  jest.mocked(liveMeetingSTT!.stop).mockResolvedValue(undefined);
  jest.mocked(liveMeetingSTT!.addListener).mockReturnValue({ remove: jest.fn() });
  jest
    .mocked(setMeetingState)
    .mockRejectedValueOnce(new Error('disk full'))
    .mockRejectedValueOnce(new Error('disk full'));

  await startMeeting('session-1');
  await expect(endMeeting()).rejects.toThrow('disk full');
  expect(currentMeeting()).toMatchObject({
    state: 'interrupted',
    error: 'Local save failed: Error: disk full',
    endedAt: expect.any(Number),
  });
});

it('labels a failed final transcript write as a local save failure', async () => {
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  jest.mocked(liveMeetingSTT!.stop).mockImplementation(async () => {
    onEvent({ kind: 'snapshot', text: 'Final words', final: true });
  });
  jest.mocked(saveTranscript).mockRejectedValueOnce(new Error('disk full'));

  await startMeeting('session-1');
  await expect(endMeeting()).rejects.toThrow('disk full');
  expect(currentMeeting()?.error).toMatch(/^Local save failed:/);
});

it('keeps a storage failure visible when the microphone later reports stopped', async () => {
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  jest.mocked(liveMeetingSTT!.stop).mockImplementation(async () => {
    onEvent({ kind: 'status', state: 'stopped' });
  });
  jest.mocked(saveTranscript).mockRejectedValueOnce(new Error('disk full'));

  await startMeeting('session-1');
  onEvent({ kind: 'snapshot', text: 'Unsaved words', final: false });
  await waitFor(() => expect(currentMeeting()?.error).toContain('Local save failed'));
  expect(currentMeeting()?.state).toBe('interrupted');
});

it('reports a late transcript write failure after native capture already failed', async () => {
  let onEvent!: (event: STTEvent) => void;
  let rejectWrite!: (reason: Error) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  jest.mocked(saveTranscript).mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectWrite = reject;
      }),
  );

  await startMeeting('session-1');
  onEvent({ kind: 'snapshot', text: 'Unsaved words', final: false });
  onEvent({ kind: 'status', state: 'failed', message: 'Microphone interrupted.' });
  await waitFor(() => expect(saveTranscript).toHaveBeenCalledTimes(1));
  rejectWrite(new Error('disk full'));

  await waitFor(() => expect(currentMeeting()?.error).toMatch(/^Local save failed:/));
  expect(currentMeeting()?.state).toBe('interrupted');
});

it.each(['failed', 'stopped'] as const)(
  'reports a local save failure when native %s state cannot be persisted',
  async (state) => {
    let onEvent!: (event: STTEvent) => void;
    jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
      onEvent = listener;
      return { remove: jest.fn() };
    });
    jest.mocked(setMeetingState).mockRejectedValueOnce(new Error('disk full'));

    await startMeeting('session-1');
    onEvent({ kind: 'status', state });

    await waitFor(() => expect(currentMeeting()?.error).toMatch(/^Local save failed:/));
    expect(currentMeeting()?.state).toBe('interrupted');
  },
);

it('creates one meeting when two screens start at the same time', async () => {
  let releaseEngines!: (
    engines: Array<{ id: 'fluid-nemotron'; name: string; available: boolean }>,
  ) => void;
  jest.mocked(liveMeetingSTT!.engines).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseEngines = resolve;
      }),
  );
  jest.mocked(liveMeetingSTT!.stop).mockResolvedValue(undefined);
  jest.mocked(liveMeetingSTT!.addListener).mockReturnValue({ remove: jest.fn() });

  const first = startMeeting('session-1');
  const second = startMeeting('session-2');
  await waitFor(() => expect(liveMeetingSTT!.engines).toHaveBeenCalled());
  releaseEngines([{ id: 'fluid-nemotron', name: 'Nemotron', available: true }]);

  await expect(first).resolves.toMatchObject({ sessionId: 'session-1' });
  await expect(second).rejects.toThrow('already active in another session');
  expect(createMeeting).toHaveBeenCalledTimes(1);
  await endMeeting();
});

it('waits for failed capture shutdown before starting another meeting', async () => {
  let onEvent!: (event: STTEvent) => void;
  let releaseStop!: () => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  jest.mocked(liveMeetingSTT!.stop).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseStop = resolve;
      }),
  );
  jest.mocked(saveTranscript).mockRejectedValueOnce(new Error('disk full'));

  await startMeeting('session-1');
  onEvent({ kind: 'snapshot', text: 'Unsaved words', final: false });
  await waitFor(() => expect(currentMeeting()?.state).toBe('interrupted'));
  const restart = startMeeting('session-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(liveMeetingSTT!.engines).toHaveBeenCalledTimes(1);
  expect(createMeeting).toHaveBeenCalledTimes(1);

  releaseStop();
  await restart;
  expect(createMeeting).toHaveBeenCalledTimes(2);
  await endMeeting();
});

it('retries a rejected native stop before creating another meeting', async () => {
  jest.mocked(liveMeetingSTT!.addListener).mockReturnValue({ remove: jest.fn() });
  jest
    .mocked(liveMeetingSTT!.stop)
    .mockRejectedValueOnce(new Error('native stop failed'))
    .mockResolvedValue(undefined);

  await startMeeting('session-1');
  await expect(endMeeting()).rejects.toThrow('native stop failed');
  await startMeeting('session-1');

  expect(liveMeetingSTT!.stop).toHaveBeenCalledTimes(2);
  expect(jest.mocked(liveMeetingSTT!.stop).mock.invocationCallOrder[1]).toBeLessThan(
    jest.mocked(createMeeting).mock.invocationCallOrder[1],
  );
  await endMeeting();
});
