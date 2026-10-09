import { VerityApiError } from '@verity/mobile';
import { isDemoMode, isEnteringDemoMode } from './demoMode';
import { liveMeetingSTT, type STTEvent } from './liveMeetingSTT';
import { createVerityClient, getVerityBaseUrl } from './client';
import { waitFor } from '@testing-library/react-native';
import {
  createMeeting,
  saveSpeakerTurns,
  saveSpeakerEdits,
  saveTranscript,
  setMeetingState,
} from './liveMeetingStore';
import {
  clearSpeakerNameSuggestion,
  currentMeeting,
  hasActiveMeetingCapture,
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  startMeeting,
  subscribeVoiceMeetingRequest,
  updateSpeakerEdits,
} from './liveMeetingSession';

jest.mock('./client', () => ({
  createVerityClient: jest.fn(),
  getVerityBaseUrl: jest.fn().mockReturnValue('https://server.example'),
}));

jest.mock('./liveMeetingSTT', () => ({
  liveMeetingSTT: {
    engines: jest.fn().mockResolvedValue([{ id: 'fluid-nemotron', available: true }]),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
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
  saveSpeakerTurns: jest.fn().mockResolvedValue(undefined),
  saveSpeakerEdits: jest.fn().mockResolvedValue(undefined),
  saveTimedWords: jest.fn().mockResolvedValue(undefined),
  setMeetingState: jest.fn().mockResolvedValue(undefined),
  touchMeeting: jest.fn().mockResolvedValue(undefined),
  setCaptureStatus: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => jest.clearAllMocks());

it('selects the larger speaker model from the expected participant count', async () => {
  await startMeeting('session-1', 'fluid-nemotron', 6);
  expect(liveMeetingSTT?.start).toHaveBeenCalledWith('fluid-nemotron', 'de-DE', ['Verity'], 6);
  await endMeeting();
});

it('keeps speaker turns without interrupting transcription when speaker storage fails', async () => {
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  jest.mocked(saveSpeakerTurns).mockRejectedValueOnce(new Error('speaker storage failed'));
  await startMeeting('session-1');
  onEvent({ kind: 'speaker-status', state: 'ready' });
  onEvent({ kind: 'speaker', speaker: 0, start: 1, end: 2 });
  await waitFor(() => expect(currentMeeting()?.speakerStatus).toBe('unavailable'));
  expect(currentMeeting()?.speakerTurns).toEqual([{ speaker: 0, start: 1, end: 2 }]);
  expect(currentMeeting()?.state).toBe('active');
  onEvent({ kind: 'snapshot', text: 'Still transcribing', final: true });
  await waitFor(() =>
    expect(saveTranscript).toHaveBeenCalledWith('meeting-1', 'Still transcribing'),
  );
  await endMeeting();
});

it('keeps a renamed speaker when another live speaker update arrives', async () => {
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  await startMeeting('session-1');
  await updateSpeakerEdits('meeting-1', { '0': 'Anna' }, [], {});
  expect(saveSpeakerEdits).toHaveBeenCalledWith('meeting-1', { '0': 'Anna' }, [], {});
  onEvent({ kind: 'speaker', speaker: 0, start: 1, end: 2 });
  expect(currentMeeting()?.speakerNames).toEqual({ '0': 'Anna' });
  await endMeeting();
});

// A whole Apple phrase stored as one timed word spanned its pauses and lost its
// speaker; the runs must become per-word timings, and open turns stay in memory only.
it('records Apple runs as word timings and keeps open diarizer turns unsaved', async () => {
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  await startMeeting('session-1');
  onEvent({
    kind: 'segment',
    text: 'Hallo zusammen',
    final: true,
    start: 0,
    end: 3,
    runs: [
      { text: 'Hallo', start: 0.1, end: 0.5 },
      { text: ' ' },
      { text: 'zusammen', start: 2, end: 2.6 },
    ],
  });
  expect(currentMeeting()?.timedWords).toEqual([
    { text: 'Hallo', start: 0.1, end: 0.5 },
    { text: 'zusammen', start: 2, end: 2.6 },
  ]);
  onEvent({
    kind: 'speaker-tentative',
    turns: [
      { speaker: 1, start: 2, end: 2.7 },
      { speaker: 9, start: 2, end: 2.7 },
    ],
    through: 3.1,
  });
  expect(currentMeeting()?.tentativeSpeakerTurns).toEqual([{ speaker: 1, start: 2, end: 2.7 }]);
  expect(currentMeeting()?.speakerHorizon).toBe(3.1);
  expect(currentMeeting()?.activeSpeaker).toBe(1);
  expect(saveSpeakerTurns).not.toHaveBeenCalled();
  await endMeeting();
});

// A name the model hears is only a suggestion: it must never replace a name the
// operator typed, and a rejected one must not come back.
it('suggests a speaker name from an introduction without overwriting a typed name', async () => {
  jest.useFakeTimers();
  try {
    let onEvent!: (event: STTEvent) => void;
    jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
      onEvent = listener;
      return { remove: jest.fn() };
    });
    const checkMeetingSpeakerName = jest
      .fn()
      .mockResolvedValue({ name: 'Holger', quote: 'Hallo, ich bin Holger.' });
    jest.mocked(createVerityClient).mockReturnValue({
      checkMeetingSpeakerName,
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    await startMeeting('session-1');
    const introduce = (start: number, speaker: number) => {
      onEvent({
        kind: 'segment',
        text: 'Hallo, ich bin Holger.',
        final: true,
        start,
        end: start + 2,
        runs: [{ text: 'Hallo, ich bin Holger.', start, end: start + 2 }],
      });
      onEvent({ kind: 'speaker', speaker, start, end: start + 2 });
    };
    introduce(0, 0);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(checkMeetingSpeakerName).toHaveBeenCalledWith('session-1', 'meeting-1', {
      text: 'Hallo, ich bin Holger.',
      hints: [],
    });
    expect(currentMeeting()?.speakerNameSuggestions).toEqual([
      { speaker: 0, name: 'Holger', quote: 'Hallo, ich bin Holger.' },
    ]);
    // After a rejection the operator names that speaker; it is not asked about again.
    clearSpeakerNameSuggestion('meeting-1', 0, true);
    expect(currentMeeting()?.speakerNameSuggestions).toEqual([]);
    introduce(20, 0);
    await jest.advanceTimersByTimeAsync(12_000);
    expect(checkMeetingSpeakerName).toHaveBeenCalledTimes(1);

    await updateSpeakerEdits('meeting-1', { '1': 'Anna' }, [], {});
    introduce(40, 1);
    await jest.advanceTimersByTimeAsync(12_000);
    expect(checkMeetingSpeakerName).toHaveBeenCalledTimes(1);
    // An unnamed new speaker is still checked.
    introduce(60, 2);
    await jest.advanceTimersByTimeAsync(12_000);
    expect(checkMeetingSpeakerName).toHaveBeenCalledTimes(2);
    expect(currentMeeting()?.speakerNames).toEqual({ '1': 'Anna' });
    await endMeeting();
  } finally {
    jest.useRealTimers();
  }
});

// A model that keeps failing must not be asked about the same speaker every ten
// seconds for the whole meeting; a server without the route stops checks entirely.
it('spends the name check budget on failures and stops on a missing route', async () => {
  jest.useFakeTimers();
  try {
    let onEvent!: (event: STTEvent) => void;
    jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
      onEvent = listener;
      return { remove: jest.fn() };
    });
    const checkMeetingSpeakerName = jest
      .fn()
      .mockRejectedValue(new VerityApiError(502, 'speaker name check failed'));
    jest.mocked(createVerityClient).mockReturnValue({
      checkMeetingSpeakerName,
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    await startMeeting('session-1');
    const introduce = (start: number, speaker: number) => {
      onEvent({
        kind: 'segment',
        text: 'I am here.',
        final: true,
        start,
        end: start + 1,
        runs: [{ text: 'I am here.', start, end: start + 1 }],
      });
      onEvent({ kind: 'speaker', speaker, start, end: start + 1 });
    };
    introduce(0, 0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(checkMeetingSpeakerName).toHaveBeenCalledTimes(3);
    checkMeetingSpeakerName.mockRejectedValue(new VerityApiError(404, 'not found'));
    introduce(100, 1);
    await jest.advanceTimersByTimeAsync(60_000);
    introduce(200, 2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(checkMeetingSpeakerName).toHaveBeenCalledTimes(4);
    await endMeeting();
  } finally {
    jest.useRealTimers();
  }
});

// Stands in for the server's model: treats "Verity, <request>." as addressed to it.
const checkSpokenMeetingRequest = jest.fn(
  async (_sessionId: string, _meetingId: string, { utterance }: { utterance: string }) => {
    const request = /^Verity, (.+?)[.?]?$/.exec(utterance)?.[1];
    if (!request) return [];
    return [{ kind: /^(research|check|recherch)/.test(request) ? 'research' : 'opinion', request }];
  },
);

it('sends a direct spoken research request once in the recording session', async () => {
  const sendTurn = jest.fn().mockResolvedValue({ turnId: 'turn-1' });
  jest
    .mocked(createVerityClient)
    .mockReturnValue({ sendTurn, checkSpokenMeetingRequest } as unknown as NonNullable<
      ReturnType<typeof createVerityClient>
    >);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  const events: string[] = [];
  const sentRequests: string[] = [];
  const unsubscribe = subscribeVoiceMeetingRequest((event) => {
    events.push(event.status);
    if (event.status === 'sent' && event.request) sentRequests.push(event.request);
  });
  try {
    await startMeeting('session-1');
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({ kind: 'snapshot', text: 'Verity, recherchiere den Liefertermin.', final: true });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    expect(sendTurn).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        prompt: expect.stringContaining('Research this point raised during live meeting meeting-1'),
      }),
    );
    onEvent({ kind: 'snapshot', text: 'Verity, recherchiere den Liefertermin.', final: true });
    await waitFor(() => expect(events).toContain('sent'));
    expect(sentRequests).toEqual(['recherchiere den Liefertermin']);
    expect(sendTurn).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    await endMeeting();
  }
});

it('queues two recognized requests in their spoken order', async () => {
  const sendTurn = jest.fn().mockResolvedValue({ turnId: 'turn-1' });
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    checkSpokenMeetingRequest,
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  try {
    await startMeeting('session-1');
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({
      kind: 'snapshot',
      text: 'Verity, research the deadline. Verity, check the budget.',
      final: false,
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
    expect(sendTurn.mock.calls.map(([, body]) => body.prompt)).toEqual([
      expect.stringContaining(
        'Research this point raised during live meeting meeting-1:\n\nresearch the deadline',
      ),
      expect.stringContaining(
        'Research this point raised during live meeting meeting-1:\n\ncheck the budget',
      ),
    ]);
  } finally {
    await endMeeting();
  }
});

it('drops a queued spoken request when capture pauses before it can send', async () => {
  let releaseFirst!: () => void;
  const sendTurn = jest.fn().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseFirst = () => resolve({ turnId: 'turn-1' });
      }),
  );
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    checkSpokenMeetingRequest,
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  try {
    await startMeeting('session-1');
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({
      kind: 'snapshot',
      text: 'Verity, research the deadline. Verity, check the budget.',
      final: false,
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    await pauseMeeting();
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await resumeMeeting();
    expect(sendTurn).toHaveBeenCalledTimes(1);
  } finally {
    await endMeeting();
  }
});

it('keeps recording and reports a rejected spoken request', async () => {
  const sendTurn = jest.fn().mockRejectedValue(new Error('offline'));
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    checkSpokenMeetingRequest,
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  const failures: string[] = [];
  const unsubscribe = subscribeVoiceMeetingRequest((event) => {
    if (event.status === 'failed') failures.push(event.message ?? '');
  });
  try {
    await startMeeting('session-1');
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({ kind: 'snapshot', text: 'Verity, was hältst du von diesem Plan?', final: false });
    await waitFor(() => expect(failures).toEqual([expect.stringContaining('offline')]));
    expect(currentMeeting()?.state).toBe('active');
  } finally {
    unsubscribe();
    await endMeeting();
  }
});

it('does not send a pending spoken request after pausing capture', async () => {
  const sendTurn = jest.fn().mockResolvedValue({ turnId: 'turn-1' });
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    checkSpokenMeetingRequest,
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  await startMeeting('session-1');
  try {
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({ kind: 'snapshot', text: 'Verity, recherchiere den Liefertermin', final: false });
    await waitFor(() =>
      expect(saveTranscript).toHaveBeenCalledWith(
        'meeting-1',
        'Verity, recherchiere den Liefertermin',
      ),
    );
    await pauseMeeting();
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(sendTurn).not.toHaveBeenCalled();
  } finally {
    await endMeeting();
  }
});

it('pauses native capture and can stop a paused meeting', async () => {
  const native = liveMeetingSTT!;
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(native.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });

  await startMeeting('session-1');
  onEvent({ kind: 'status', state: 'listening' });
  await pauseMeeting();
  expect(native.pause).toHaveBeenCalledTimes(1);
  expect(currentMeeting()?.captureStatus).toBe('paused');
  await resumeMeeting();
  expect(native.resume).toHaveBeenCalledTimes(1);
  expect(currentMeeting()?.captureStatus).toBe('listening');
  await pauseMeeting();
  await endMeeting();
  expect(native.stop).toHaveBeenCalledTimes(1);
  expect(currentMeeting()?.state).toBe('ended');
});

it('rejects a delayed control command aimed at a different recording', async () => {
  const native = liveMeetingSTT!;
  jest.mocked(native.addListener).mockImplementation((_name, listener) => {
    listener({ kind: 'status', state: 'listening' });
    return { remove: jest.fn() };
  });
  await startMeeting('session-1');
  await expect(pauseMeeting('previous-meeting')).rejects.toThrow('Recording changed');
  await expect(resumeMeeting('previous-meeting')).rejects.toThrow('Recording changed');
  await expect(endMeeting('previous-meeting')).rejects.toThrow('Recording changed');
  expect(native.pause).not.toHaveBeenCalled();
  expect(native.resume).not.toHaveBeenCalled();
  expect(native.stop).not.toHaveBeenCalled();
  await endMeeting();
});

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
  expect(createMeeting).toHaveBeenCalledWith('session-1', 'fluid-nemotron', null);
  expect(jest.mocked(createMeeting).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(native.start).mock.invocationCallOrder[0],
  );
  expect(native.start).toHaveBeenCalledWith('fluid-nemotron', 'de-DE', ['Verity'], 4);

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

it('sends nothing when the server says Verity was only talked about', async () => {
  const sendTurn = jest.fn().mockResolvedValue({ turnId: 'turn-1' });
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    checkSpokenMeetingRequest,
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  const events: string[] = [];
  const unsubscribe = subscribeVoiceMeetingRequest((event) => events.push(event.status));
  try {
    await startMeeting('session-1');
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({
      kind: 'snapshot',
      text: 'Das Budget steht. Wir haben gestern Verity getestet.',
      final: true,
    });
    await waitFor(() =>
      expect(checkSpokenMeetingRequest).toHaveBeenCalledWith('session-1', 'meeting-1', {
        utterance: 'Wir haben gestern Verity getestet.',
        context: 'Das Budget steht.',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A mention must stay invisible: no "sending" flash, no turn in the chat.
    expect(events).toEqual([]);
    expect(sendTurn).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    await endMeeting();
  }
});

it('reports a failed check and keeps recording', async () => {
  const sendTurn = jest.fn();
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    checkSpokenMeetingRequest: jest.fn().mockRejectedValue(new Error('offline')),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  const failures: string[] = [];
  const unsubscribe = subscribeVoiceMeetingRequest((event) => {
    if (event.status === 'failed') failures.push(event.message ?? '');
  });
  try {
    await startMeeting('session-1');
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({
      kind: 'snapshot',
      text: 'Kurz noch: kannst du, Verity, die Preise prüfen?',
      final: true,
    });
    await waitFor(() => expect(failures).toEqual([expect.stringContaining('offline')]));
    expect(sendTurn).not.toHaveBeenCalled();
    expect(currentMeeting()?.state).toBe('active');
  } finally {
    unsubscribe();
    await endMeeting();
  }
});

it('drops a checked request when capture pauses while the server is still deciding', async () => {
  let decide!: (requests: { kind: string; request: string }[]) => void;
  const sendTurn = jest.fn().mockResolvedValue({ turnId: 'turn-1' });
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    checkSpokenMeetingRequest: jest.fn(() => new Promise((resolve) => (decide = resolve))),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  const events: string[] = [];
  const unsubscribe = subscribeVoiceMeetingRequest((event) => events.push(event.status));
  try {
    await startMeeting('session-1');
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({ kind: 'snapshot', text: 'Verity, prüfe das Budget.', final: true });
    await waitFor(() => expect(decide).toBeDefined());
    await pauseMeeting();
    decide([{ kind: 'research', request: 'prüfe das Budget' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A paused meeting must not flash "sending" for a request it then drops.
    expect(events).toEqual([]);
    expect(sendTurn).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    await endMeeting();
  }
});

it('stays silent when checking a passing mention fails', async () => {
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn: jest.fn(),
    checkSpokenMeetingRequest: jest.fn().mockRejectedValue(new Error('offline')),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  const events: string[] = [];
  const unsubscribe = subscribeVoiceMeetingRequest((event) => events.push(event.status));
  try {
    await startMeeting('session-1');
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({ kind: 'snapshot', text: 'Wir haben gestern Verity getestet.', final: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([]);
  } finally {
    unsubscribe();
    await endMeeting();
  }
});

it('does not leave "sending" on screen when capture pauses between two requests', async () => {
  let releaseFirst!: () => void;
  const sendTurn = jest
    .fn()
    .mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = () => resolve({ turnId: 'turn-1' }))),
    );
  jest.mocked(createVerityClient).mockReturnValue({
    sendTurn,
    checkSpokenMeetingRequest: jest.fn().mockResolvedValue([
      { kind: 'research', request: 'research the hosting costs' },
      { kind: 'opinion', request: 'what do you think about the launch' },
    ]),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });
  const events: string[] = [];
  const unsubscribe = subscribeVoiceMeetingRequest((event) => events.push(event.status));
  try {
    await startMeeting('session-1');
    onEvent({ kind: 'status', state: 'listening' });
    onEvent({
      kind: 'snapshot',
      text: 'Verity research the hosting costs Verity what do you think about the launch.',
      final: true,
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    await pauseMeeting();
    releaseFirst();
    await waitFor(() => expect(events).toEqual(['sending', 'sent', 'failed']));
    expect(sendTurn).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    await endMeeting();
  }
});

jest.mock('./demoMode', () => ({
  isDemoMode: jest.fn().mockReturnValue(false),
  isEnteringDemoMode: jest.fn().mockReturnValue(false),
}));
afterEach(() => jest.mocked(isDemoMode).mockReturnValue(false));

it('reports pending starts and active capture until the meeting ends', async () => {
  const pending = startMeeting('session-1');
  expect(hasActiveMeetingCapture()).toBe(true);
  try {
    await pending;
    expect(hasActiveMeetingCapture()).toBe(true);
  } finally {
    await endMeeting();
  }
  expect(hasActiveMeetingCapture()).toBe(false);
});

it('does not start native capture during an asynchronous demo transition', async () => {
  jest.mocked(isEnteringDemoMode).mockReturnValue(true);
  try {
    await expect(startMeeting('session-1')).rejects.toThrow('Exit the demo');
    expect(createMeeting).not.toHaveBeenCalled();
    expect(liveMeetingSTT?.start).not.toHaveBeenCalled();
  } finally {
    jest.mocked(isEnteringDemoMode).mockReturnValue(false);
  }
});

it('does not create a persisted meeting or start native capture in demo mode', async () => {
  jest.mocked(isDemoMode).mockReturnValue(true);
  await expect(startMeeting('demo-session')).rejects.toThrow('Exit the demo');
  expect(createMeeting).not.toHaveBeenCalled();
  expect(liveMeetingSTT?.engines).not.toHaveBeenCalled();
  expect(liveMeetingSTT?.start).not.toHaveBeenCalled();
});

it('keeps speaker identity unchanged when saving a name fails', async () => {
  await startMeeting('session-1');
  try {
    jest.mocked(saveSpeakerEdits).mockRejectedValueOnce(new Error('disk full'));
    await expect(updateSpeakerEdits('meeting-1', { '0': 'Anna' }, [], {})).rejects.toThrow(
      'disk full',
    );
    expect(currentMeeting()?.speakerNames?.['0']).toBeUndefined();
  } finally {
    await endMeeting();
  }
});

it('checks a new meeting while the previous name request is still pending', async () => {
  jest.useFakeTimers();
  let finish!: (value: { name: string; quote: string }) => void;
  try {
    let onEvent!: (event: STTEvent) => void;
    jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
      onEvent = listener;
      return { remove: jest.fn() };
    });
    const checkMeetingSpeakerName = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ name: 'Anna', quote: 'Hi, ich bin Anna.' });
    jest
      .mocked(createVerityClient)
      .mockReturnValue({ checkMeetingSpeakerName } as unknown as NonNullable<
        ReturnType<typeof createVerityClient>
      >);
    const introduce = () => {
      onEvent({
        kind: 'segment',
        text: 'Hi, ich bin Anna.',
        final: true,
        start: 0,
        end: 2,
        runs: [{ text: 'Hi, ich bin Anna.', start: 0, end: 2 }],
      });
      onEvent({ kind: 'speaker', speaker: 0, start: 0, end: 2 });
    };
    await startMeeting('session-1');
    introduce();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(checkMeetingSpeakerName).toHaveBeenCalledTimes(1);
    await endMeeting();
    await startMeeting('session-1');
    introduce();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(checkMeetingSpeakerName).toHaveBeenCalledTimes(2);
    finish({ name: 'Old name', quote: 'Old introduction' });
    await jest.advanceTimersByTimeAsync(1);
    expect(currentMeeting()?.speakerNameSuggestions).toEqual([
      { speaker: 0, name: 'Anna', quote: 'Hi, ich bin Anna.' },
    ]);
  } finally {
    await endMeeting();
    jest.useRealTimers();
  }
});

it.each(['pause', 'switch server'] as const)(
  'settles sending when capture changes during model discovery: %s',
  async (change) => {
    let resolveSession!: (session: { model: string }) => void;
    const sendTurn = jest.fn().mockResolvedValue({ turnId: 'turn-1' });
    jest.mocked(createVerityClient).mockReturnValue({
      sendTurn,
      checkSpokenMeetingRequest: jest
        .fn()
        .mockResolvedValue([{ kind: 'research', request: 'prüfe das Budget' }]),
      getSession: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          }),
      ),
      listModels: jest.fn().mockResolvedValue({ models: [] }),
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    let onEvent!: (event: STTEvent) => void;
    jest.mocked(liveMeetingSTT!.addListener).mockImplementation((_name, listener) => {
      onEvent = listener;
      return { remove: jest.fn() };
    });
    const events: string[] = [];
    const unsubscribe = subscribeVoiceMeetingRequest((event) => events.push(event.status));
    try {
      await startMeeting('session-1');
      onEvent({ kind: 'status', state: 'listening' });
      onEvent({ kind: 'snapshot', text: 'Verity, prüfe das Budget.', final: true });
      await waitFor(() => expect(resolveSession).toBeDefined());
      expect(events).toEqual(['sending']);
      if (change === 'pause') await pauseMeeting();
      else jest.mocked(getVerityBaseUrl).mockReturnValue('https://other.example');
      resolveSession({ model: 'claude-opus-5-5' });
      await waitFor(() => expect(events).toEqual(['sending', 'failed']));
      expect(sendTurn).not.toHaveBeenCalled();
    } finally {
      jest.mocked(getVerityBaseUrl).mockReturnValue('https://server.example');
      unsubscribe();
      await endMeeting();
    }
  },
);
