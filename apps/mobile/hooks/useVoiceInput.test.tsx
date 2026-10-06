import { isDemoMode } from '../lib/demoMode';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useVoiceInput } from './useVoiceInput';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

const handlers: Record<
  string,
  (event: { results?: { transcript: string }[]; isFinal?: boolean; value?: number }) => void
> = {};

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
jest.mock('expo-speech-recognition', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const listeners: Record<string, Set<(event: never) => void>> = {};
  const nativeListeners: Record<string, Set<(event: never) => void>> = {};
  return {
    useSpeechRecognitionEvent: (name: string, handler: (event: never) => void) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      handlers[name] = (event) => {
        for (const listener of nativeListeners[name] ?? []) listener(event as never);
        for (const listener of listeners[name] ?? []) listener(event as never);
      };
      React.useEffect(() => {
        const listener = (event: never) => latest.current(event);
        (listeners[name] ??= new Set()).add(listener);
        return () => {
          listeners[name]?.delete(listener);
        };
      }, [name]);
    },
    ExpoSpeechRecognitionModule: {
      requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
      getSupportedLocales: jest.fn().mockResolvedValue({ installedLocales: ['en-US'] }),
      start: jest.fn(),
      stop: jest.fn(),
      abort: jest.fn(() => {
        for (const listener of nativeListeners.end ?? []) listener({} as never);
        handlers.end?.({});
      }),
      addListener: (name: string, listener: (event: never) => void) => {
        (nativeListeners[name] ??= new Set()).add(listener);
        return { remove: () => nativeListeners[name]?.delete(listener) };
      },
    },
  };
});

it('stops continuous dictation on a second long press', async () => {
  jest.useFakeTimers();
  const onAutoSend = jest.fn().mockResolvedValue(true);
  const { result } = renderHook(() => useVoiceInput('', jest.fn(), onAutoSend));
  act(() => result.current.startAuto());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Keep this draft' }], isFinal: true }));
  expect(result.current.countdown).toBe(3);

  act(() => result.current.startAuto());
  expect(result.current.autoMode).toBe(false);
  expect(result.current.countdown).toBeNull();
  expect(ExpoSpeechRecognitionModule.stop).toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(6000));
  expect(onAutoSend).not.toHaveBeenCalled();
  jest.useRealTimers();
});

it('lets a tap cancel automatic send until more speech arrives', async () => {
  jest.useFakeTimers();
  const onChangeText = jest.fn();
  const onAutoSend = jest.fn().mockResolvedValue(true);
  const { result } = renderHook(() => useVoiceInput('', onChangeText, onAutoSend));

  act(() => result.current.startAuto());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'First thought' }], isFinal: true }));
  expect(result.current.countdown).toBe(3);
  act(() => result.current.pauseCountdown());
  act(() => jest.advanceTimersByTime(6000));
  expect(onAutoSend).not.toHaveBeenCalled();
  expect(onChangeText).toHaveBeenLastCalledWith('First thought');

  act(() => handlers.result({ results: [{ transcript: 'second thought' }], isFinal: false }));
  act(() => handlers.result({ results: [{ transcript: 'second thought' }], isFinal: true }));
  expect(result.current.countdown).toBe(3);
  act(() => jest.advanceTimersByTime(3000));
  expect(result.current.countdown).toBe(2);
  expect(onAutoSend).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(2000));
  expect(result.current.countdown).toBe(1);
  expect(onAutoSend).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(400));
  expect(onAutoSend).toHaveBeenCalledWith('First thought second thought');
  await act(async () => Promise.resolve());
  expect(result.current.state).toBe('recording');
  act(() => handlers.result({ results: [{ transcript: 'Next message' }], isFinal: true }));
  act(() => jest.advanceTimersByTime(5400));
  expect(onAutoSend).toHaveBeenLastCalledWith('Next message');
  jest.useRealTimers();
});

it('schedules the next dictated message when the previous send finishes', async () => {
  jest.useFakeTimers();
  let acceptFirst!: (accepted: boolean) => void;
  const firstSend = new Promise<boolean>((resolve) => {
    acceptFirst = resolve;
  });
  const onAutoSend = jest
    .fn<Promise<boolean>, [string]>()
    .mockReturnValueOnce(firstSend)
    .mockResolvedValue(true);
  const { result } = renderHook(() => useVoiceInput('', jest.fn(), onAutoSend));
  act(() => result.current.startAuto());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'First' }], isFinal: true }));
  act(() => jest.advanceTimersByTime(5400));
  act(() => handlers.result({ results: [{ transcript: 'Second' }], isFinal: true }));
  expect(onAutoSend).toHaveBeenCalledTimes(1);
  await act(async () => acceptFirst(true));
  act(() => jest.advanceTimersByTime(5400));
  expect(onAutoSend).toHaveBeenLastCalledWith('Second');
  jest.useRealTimers();
});

it('does not send a draft changed during the countdown', async () => {
  jest.useFakeTimers();
  const onAutoSend = jest.fn().mockResolvedValue(true);
  const { result } = renderHook(() => useVoiceInput('', jest.fn(), onAutoSend));
  act(() => result.current.startAuto());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Original' }], isFinal: true }));
  act(() => result.current.onComposerEdit('Corrected'));
  act(() => jest.advanceTimersByTime(6000));
  expect(onAutoSend).not.toHaveBeenCalled();
  act(() => handlers.result({ results: [{ transcript: 'Next words' }], isFinal: true }));
  act(() => jest.advanceTimersByTime(5400));
  expect(onAutoSend).toHaveBeenCalledWith('Corrected Next words');
  jest.useRealTimers();
});

it('keeps a manual edit made during interim recognition without duplicating speech', async () => {
  jest.useFakeTimers();
  const onChangeText = jest.fn();
  const onAutoSend = jest.fn().mockResolvedValue(true);
  const { result } = renderHook(() => useVoiceInput('', onChangeText, onAutoSend));
  act(() => result.current.startAuto());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Partial' }], isFinal: false }));
  act(() => result.current.onComposerEdit('Edited'));
  act(() => handlers.result({ results: [{ transcript: 'Partial phrase' }], isFinal: false }));
  act(() => handlers.result({ results: [{ transcript: 'Partial phrase' }], isFinal: true }));
  expect(onChangeText).toHaveBeenLastCalledWith('Partial');
  act(() => jest.advanceTimersByTime(6000));
  expect(onAutoSend).not.toHaveBeenCalled();
  act(() => handlers.result({ results: [{ transcript: 'New words' }], isFinal: true }));
  act(() => jest.advanceTimersByTime(5400));
  expect(onAutoSend).toHaveBeenCalledWith('Edited New words');
  jest.useRealTimers();
});

it('does not restart a countdown after the screen closes during a send', async () => {
  jest.useFakeTimers();
  let accept!: (accepted: boolean) => void;
  const onAutoSend = jest.fn(() => new Promise<boolean>((resolve) => (accept = resolve)));
  const { result, unmount } = renderHook(() => useVoiceInput('', jest.fn(), onAutoSend));
  act(() => result.current.startAuto());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'First' }], isFinal: true }));
  act(() => jest.advanceTimersByTime(5400));
  act(() => handlers.result({ results: [{ transcript: 'Second' }], isFinal: true }));
  unmount();
  await act(async () => accept(true));
  act(() => jest.advanceTimersByTime(6000));
  expect(onAutoSend).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

it('preserves manual edits after dictation stops if an in-flight send fails', async () => {
  jest.useFakeTimers();
  let rejectSend!: (accepted: boolean) => void;
  const onAutoSend = jest.fn(() => new Promise<boolean>((resolve) => (rejectSend = resolve)));
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', onChangeText, onAutoSend));
  act(() => result.current.startAuto());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Submitted' }], isFinal: true }));
  act(() => jest.advanceTimersByTime(5400));
  act(() => handlers.end({}));
  act(() => result.current.onComposerEdit('My correction'));
  const writesBeforeRejection = onChangeText.mock.calls.length;
  await act(async () => rejectSend(false));
  expect(onChangeText).toHaveBeenCalledTimes(writesBeforeRejection);
  jest.useRealTimers();
});

it('keeps the draft once when stopping repeats the final recognition result', async () => {
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('Existing draft', onChangeText));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  const final = { results: [{ transcript: 'Dictated words' }], isFinal: true };
  act(() => handlers.result(final));
  act(() => result.current.toggle());
  act(() => handlers.result(final));
  act(() => handlers.result(final));
  act(() => handlers.end({}));
  expect(onChangeText).toHaveBeenLastCalledWith('Existing draft Dictated words');
  expect(onChangeText).toHaveBeenCalledTimes(1);
});

it('allows the same words in a new utterance after interim recognition', async () => {
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', onChangeText));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Again' }], isFinal: true }));
  act(() => handlers.result({ results: [{ transcript: 'Again' }], isFinal: false }));
  act(() => handlers.result({ results: [{ transcript: 'Again' }], isFinal: true }));
  expect(onChangeText).toHaveBeenLastCalledWith('Again Again');
});

jest.mock('../lib/demoMode', () => ({ isDemoMode: jest.fn().mockReturnValue(false) }));
afterEach(() => jest.mocked(isDemoMode).mockReturnValue(false));

it('keeps demo dictation away from microphone permissions and native recognition', () => {
  jest.clearAllMocks();
  jest.mocked(isDemoMode).mockReturnValue(true);
  const { result } = renderHook(() => useVoiceInput('', jest.fn()));
  act(() => result.current.toggle());
  expect(result.current.state).toBe('idle');
  expect(result.current.error).toContain('local demo');
  expect(ExpoSpeechRecognitionModule.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(ExpoSpeechRecognitionModule.start).not.toHaveBeenCalled();
});

// iOS 18 prefixes results after a pause-final with a space, so the repeat it
// emits on stop never matched the committed final byte for byte.
it('keeps the draft once when stopping repeats the final with a leading space', async () => {
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', onChangeText));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Dictated words' }], isFinal: false }));
  act(() => handlers.result({ results: [{ transcript: 'Dictated words' }], isFinal: true }));
  act(() => result.current.toggle());
  act(() => handlers.result({ results: [{ transcript: ' Dictated words.' }], isFinal: true }));
  act(() => handlers.end({}));
  expect(onChangeText).toHaveBeenLastCalledWith('Dictated words');
  expect(onChangeText).not.toHaveBeenCalledWith('Dictated words Dictated words.');
});

it('ignores a replayed interim of the committed final after stop', async () => {
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', onChangeText));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Dictated words' }], isFinal: true }));
  act(() => result.current.toggle());
  act(() => handlers.result({ results: [{ transcript: ' Dictated words' }], isFinal: false }));
  act(() => handlers.result({ results: [{ transcript: ' Dictated words' }], isFinal: true }));
  act(() => handlers.end({}));
  expect(onChangeText).toHaveBeenCalledTimes(1);
  expect(onChangeText).toHaveBeenLastCalledWith('Dictated words');
});

it('commits an utterance still open when stop is tapped', async () => {
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', onChangeText));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Again' }], isFinal: true }));
  act(() => handlers.result({ results: [{ transcript: ' Again' }], isFinal: false }));
  act(() => result.current.toggle());
  act(() => handlers.result({ results: [{ transcript: ' Again' }], isFinal: true }));
  expect(onChangeText).toHaveBeenLastCalledWith('Again Again');
});

it('ignores a replay of the utterance committed after stop', async () => {
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', onChangeText));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Again' }], isFinal: false }));
  act(() => result.current.toggle());
  act(() => handlers.result({ results: [{ transcript: 'Again' }], isFinal: true }));
  act(() => handlers.result({ results: [{ transcript: ' Again' }], isFinal: false }));
  act(() => handlers.result({ results: [{ transcript: ' Again.' }], isFinal: true }));
  act(() => handlers.end({}));
  expect(onChangeText).toHaveBeenLastCalledWith('Again');
});

it('ignores a replay that streams in word by word after stop', async () => {
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', onChangeText));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Dictated words' }], isFinal: true }));
  act(() => result.current.toggle());
  act(() => handlers.result({ results: [{ transcript: ' Dictated' }], isFinal: false }));
  act(() => handlers.result({ results: [{ transcript: ' Dictated words.' }], isFinal: true }));
  act(() => handlers.end({}));
  expect(onChangeText).toHaveBeenCalledTimes(1);
  expect(onChangeText).toHaveBeenLastCalledWith('Dictated words');
});

it('restores the committed text when a mid-word replay interim slips through after stop', async () => {
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', onChangeText));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Dictated words' }], isFinal: true }));
  act(() => result.current.toggle());
  act(() => handlers.result({ results: [{ transcript: ' Dictat' }], isFinal: false }));
  act(() => handlers.result({ results: [{ transcript: ' Dictated words.' }], isFinal: true }));
  act(() => handlers.end({}));
  expect(onChangeText).toHaveBeenLastCalledWith('Dictated words');
});

it('keeps new speech after stop that starts like the committed final', async () => {
  const onChangeText = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', onChangeText));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  act(() => handlers.result({ results: [{ transcript: 'Yes I agree' }], isFinal: true }));
  act(() => result.current.toggle());
  act(() => handlers.result({ results: [{ transcript: ' Yes' }], isFinal: false }));
  act(() => handlers.result({ results: [{ transcript: ' Yes' }], isFinal: true }));
  act(() => handlers.end({}));
  expect(onChangeText).toHaveBeenLastCalledWith('Yes I agree Yes');
});

it('keeps another mounted voice input from stealing recognition or reacting to its end', async () => {
  const composerText = jest.fn();
  const captureText = jest.fn();
  const { result } = renderHook(() => ({
    composer: useVoiceInput('', composerText),
    capture: useVoiceInput('', captureText),
  }));
  act(() => result.current.composer.toggle());
  await waitFor(() => expect(result.current.composer.state).toBe('recording'));
  act(() => result.current.capture.startAuto());
  expect(result.current.capture.error).toBe('Another voice recording is active');
  expect(result.current.capture.autoMode).toBe(false);
  act(() => handlers.result({ results: [{ transcript: 'Composer only' }], isFinal: true }));
  expect(composerText).toHaveBeenCalledWith('Composer only');
  expect(captureText).not.toHaveBeenCalled();
  act(() => handlers.end({}));
  expect(result.current.composer.state).toBe('idle');
});

it('stops capture after silence and accepts the final result before end', async () => {
  jest.useFakeTimers();
  const change = jest.fn();
  const { result } = renderHook(() => useVoiceInput('', change, undefined, { silenceMs: 1500 }));
  act(() => result.current.toggle());
  await waitFor(() => expect(result.current.state).toBe('recording'));
  const before = jest.mocked(ExpoSpeechRecognitionModule.stop).mock.calls.length;
  act(() => handlers.result({ results: [{ transcript: 'Partial' }], isFinal: false }));
  act(() => handlers.volumechange({ value: -1 }));
  act(() => jest.advanceTimersByTime(1499));
  expect(ExpoSpeechRecognitionModule.stop).toHaveBeenCalledTimes(before);
  act(() => jest.advanceTimersByTime(1));
  expect(ExpoSpeechRecognitionModule.stop).toHaveBeenCalledTimes(before + 1);
  expect(result.current.state).toBe('recording');
  act(() => handlers.result({ results: [{ transcript: 'Final capture' }], isFinal: true }));
  expect(change).toHaveBeenLastCalledWith('Final capture');
  act(() => handlers.end({}));
  expect(result.current.state).toBe('idle');
  jest.useRealTimers();
});

it('holds recognition ownership until cancellation finishes after unmount', async () => {
  const first = renderHook(() => useVoiceInput('', jest.fn()));
  act(() => first.result.current.toggle());
  await waitFor(() => expect(first.result.current.state).toBe('recording'));
  jest.mocked(ExpoSpeechRecognitionModule.abort).mockImplementationOnce(() => undefined);
  first.unmount();
  const second = renderHook(() => useVoiceInput('', jest.fn()));
  act(() => second.result.current.toggle());
  expect(second.result.current.error).toBe('Another voice recording is active');
  act(() => handlers.end({}));
  act(() => second.result.current.toggle());
  await waitFor(() => expect(second.result.current.state).toBe('recording'));
});
