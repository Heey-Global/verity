import { act, renderHook, waitFor } from '@testing-library/react-native';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { useVoiceInput } from './useVoiceInput';
import { correctVoiceText } from '../lib/voiceVocabulary';

let listener: (event: Record<string, unknown>) => void;
jest.mock('expo-modules-core', () => {
  const native = {
    dictationLocales: jest.fn(async () => ['de-DE']),
    startDictation: jest.fn(
      async (_session: string, _locale: string, _vocabulary: string[]) => undefined,
    ),
    stopDictation: jest.fn(async (_session: string, _abort: boolean) => undefined),
    addListener: jest.fn((_name: string, callback: (event: Record<string, unknown>) => void) => {
      listener = callback;
      return { remove: jest.fn() };
    }),
  };
  return { ...jest.requireActual('expo-modules-core'), requireOptionalNativeModule: () => native };
});
const mockNative = jest.requireMock('expo-modules-core').requireOptionalNativeModule() as {
  dictationLocales: jest.Mock<Promise<string[]>>;
  startDictation: jest.Mock<Promise<void>, [string, string, string[]]>;
  stopDictation: jest.Mock<Promise<void>, [string, boolean]>;
};
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'de-DE' }] }));
jest.mock('../lib/voiceVocabulary', () => ({
  loadVoiceVocabulary: jest.fn(async () => ({
    enabled: true,
    terms: [{ term: 'GitHub', aliases: [] }],
  })),
  correctVoiceText: jest.fn((text: string) => text.replace(/github/gi, 'GitHub')),
}));
jest.mock('../lib/demoMode', () => ({ isDemoMode: () => false }));
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { start: jest.fn(), requestPermissionsAsync: jest.fn() },
  useSpeechRecognitionEvent: jest.fn(),
}));

function segment(text: string, final: boolean, start = 0, session?: string) {
  listener({
    kind: 'segment',
    text,
    final,
    start,
    session: session ?? mockNative.startDictation.mock.calls.at(-1)?.[0],
  });
}
afterEach(() => jest.clearAllMocks());

it('uses SpeechTranscriber exclusively and corrects finals before task/chat consumption', async () => {
  const change = jest.fn();
  const hook = renderHook(() => useVoiceInput('Typed github', change));
  act(() => hook.result.current.toggle());
  await waitFor(() => expect(mockNative.startDictation).toHaveBeenCalled());
  expect(ExpoSpeechRecognitionModule.start).not.toHaveBeenCalled();
  expect(ExpoSpeechRecognitionModule.requestPermissionsAsync).not.toHaveBeenCalled();
  act(() => segment('github', false));
  expect(change).toHaveBeenLastCalledWith('Typed github github');
  act(() => segment('github', true));
  expect(change).toHaveBeenLastCalledWith('Typed github GitHub');
  expect(correctVoiceText).toHaveBeenCalledTimes(1);
  act(() => segment('github', true));
  expect(change).toHaveBeenCalledTimes(2);
  act(() => segment('github', true, 1));
  expect(change).toHaveBeenLastCalledWith('Typed github GitHub GitHub');
  act(() => hook.result.current.abort());
  await waitFor(() => expect(hook.result.current.state).toBe('idle'));
  hook.unmount();
});

it('drains final text on stop and ignores late results after abort', async () => {
  let finish!: () => void;
  mockNative.stopDictation.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const change = jest.fn();
  const hook = renderHook(() => useVoiceInput('', change));
  act(() => hook.result.current.toggle());
  await waitFor(() => expect(mockNative.startDictation).toHaveBeenCalled());
  act(() => segment('git', false));
  act(() => hook.result.current.toggle());
  expect(hook.result.current.state).toBe('recording');
  act(() => segment('github', true));
  expect(change).toHaveBeenLastCalledWith('GitHub');
  await act(async () => finish());
  expect(hook.result.current.state).toBe('idle');
  act(() => hook.result.current.toggle());
  await waitFor(() => expect(mockNative.startDictation).toHaveBeenCalledTimes(2));
  act(() => hook.result.current.abort());
  act(() => segment('late', true));
  expect(change).toHaveBeenLastCalledWith('GitHub');
  await act(async () => {});
  hook.unmount();
});

it('preserves manual edits and reports preparation and unsupported languages', async () => {
  const change = jest.fn();
  const hook = renderHook(() => useVoiceInput('', change));
  act(() => hook.result.current.toggle());
  await waitFor(() => expect(mockNative.startDictation).toHaveBeenCalled());
  act(() =>
    listener({
      kind: 'status',
      state: 'downloading',
      session: mockNative.startDictation.mock.calls.at(-1)?.[0],
    }),
  );
  expect(hook.result.current.preparation).toBe('downloading');
  act(() => segment('github', false));
  act(() => hook.result.current.onComposerEdit('My edit'));
  act(() => segment('github', true));
  expect(change).toHaveBeenCalledTimes(1);
  act(() => hook.result.current.abort());
  await act(async () => {});
  mockNative.dictationLocales.mockResolvedValueOnce([]);
  act(() => hook.result.current.toggle());
  await waitFor(() => expect(hook.result.current.error).toMatch(/unavailable/));
  expect(hook.result.current.state).toBe('idle');
  expect(ExpoSpeechRecognitionModule.start).not.toHaveBeenCalled();
  hook.unmount();
});

it('does not restart an abandoned preparation after a new attempt begins', async () => {
  let resolve!: (locales: string[]) => void;
  mockNative.dictationLocales.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const hook = renderHook(() => useVoiceInput('', jest.fn()));
  act(() => hook.result.current.toggle());
  await waitFor(() => expect(mockNative.dictationLocales).toHaveBeenCalled());
  act(() => hook.result.current.toggle());
  expect(hook.result.current.state).toBe('idle');
  act(() => hook.result.current.toggle());
  await waitFor(() => expect(mockNative.startDictation).toHaveBeenCalledTimes(1));
  await act(async () => resolve(['de-DE']));
  expect(mockNative.startDictation).toHaveBeenCalledTimes(1);
  act(() => hook.result.current.abort());
  await act(async () => {});
  hook.unmount();
});

it('rejects competing chat/task recordings and never falls back when a meeting owns the mic', async () => {
  mockNative.startDictation.mockRejectedValueOnce(new Error('Another voice recording is active.'));
  const first = renderHook(() => useVoiceInput('', jest.fn()));
  const second = renderHook(() => useVoiceInput('', jest.fn()));
  act(() => {
    first.result.current.toggle();
    second.result.current.toggle();
  });
  expect(second.result.current.error).toMatch(/Another voice/);
  await waitFor(() => expect(first.result.current.error).toMatch(/Another voice/));
  expect(ExpoSpeechRecognitionModule.start).not.toHaveBeenCalled();
  first.unmount();
  second.unmount();
});

it('sends corrected final text automatically and discards foreign-session events', async () => {
  jest.useFakeTimers();
  const change = jest.fn();
  const send = jest.fn(async () => true);
  const hook = renderHook(() => useVoiceInput('', change, send));
  act(() => hook.result.current.startAuto());
  await act(async () => {});
  expect(mockNative.startDictation).toHaveBeenCalled();
  act(() => segment('wrong', true, 0, 'old-session'));
  expect(change).not.toHaveBeenCalled();
  act(() => segment('github', true));
  expect(change).toHaveBeenCalledWith('GitHub');
  expect(hook.result.current.autoMode).toBe(true);
  expect(hook.result.current.countdown).toBe(3);
  await act(async () => jest.advanceTimersByTime(5400));
  expect(send).toHaveBeenCalledWith('GitHub');
  act(() => hook.result.current.abort());
  await act(async () => {});
  hook.unmount();
  jest.useRealTimers();
});

it('rejects unmatched preferred languages even when another model is supported', async () => {
  mockNative.dictationLocales.mockResolvedValueOnce(['en-US']);
  const hook = renderHook(() => useVoiceInput('', jest.fn()));
  act(() => hook.result.current.toggle());
  await waitFor(() => expect(hook.result.current.error).toMatch(/unavailable/));
  expect(mockNative.startDictation).not.toHaveBeenCalled();
  expect(ExpoSpeechRecognitionModule.start).not.toHaveBeenCalled();
  hook.unmount();
});
