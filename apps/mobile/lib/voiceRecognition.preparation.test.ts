import { act, renderHook } from '@testing-library/react-native';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { AppState } from 'react-native';
import { voiceRecognition } from './voiceRecognition';

jest.mock('../lib/demoMode', () => ({ isDemoMode: () => false }));
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
jest.mock('expo-modules-core', () => {
  const native = {
    dictationLocales: jest.fn(async () => ['en-US', 'de-DE']),
    prepareDictation: jest.fn(async () => undefined),
    releasePreparedDictation: jest.fn(async () => undefined),
    startDictation: jest.fn(async () => undefined),
    stopDictation: jest.fn(async () => undefined),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  };
  return { ...jest.requireActual('expo-modules-core'), requireOptionalNativeModule: () => native };
});
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { addListener: jest.fn() },
  useSpeechRecognitionEvent: jest.fn(),
}));
jest.mock('../lib/voiceVocabulary', () => ({
  loadVoiceVocabulary: jest.fn(async () => ({ terms: [], enabled: true })),
  correctVoiceText: (text: string) => text,
}));
const native = jest.requireMock('expo-modules-core').requireOptionalNativeModule() as {
  dictationLocales: jest.Mock;
  prepareDictation: jest.Mock;
  releasePreparedDictation: jest.Mock;
  startDictation: jest.Mock;
  stopDictation: jest.Mock;
};
let applicationChanged: (state: string) => void;
let disposers: (() => void)[];
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function retain(tags = ['en-US']) {
  const dispose = voiceRecognition.retainPreparation(tags);
  disposers.push(dispose);
  return dispose;
}
function state(value: string) {
  Object.defineProperty(AppState, 'currentState', { value, configurable: true });
  applicationChanged(value);
}
beforeEach(() => {
  jest.useFakeTimers();
  disposers = [];
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, callback) => {
    applicationChanged = callback as (state: string) => void;
    return { remove: jest.fn() };
  });
});
afterEach(async () => {
  for (const dispose of disposers) dispose();
  jest.advanceTimersByTime(60_000);
  await flush();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  jest.useRealTimers();
});

it('coalesces simultaneous consumers without starting or requesting an audio recording', async () => {
  retain();
  retain();
  await flush();
  expect(native.prepareDictation).toHaveBeenCalledTimes(1);
  expect(native.prepareDictation).toHaveBeenCalledWith('en-US');
  expect(native.startDictation).not.toHaveBeenCalled();
  expect(native.stopDictation).not.toHaveBeenCalled();
});

it('keeps preparation for the blur grace period and releases at its deadline', async () => {
  const dispose = retain();
  await flush();
  dispose();
  disposers = [];
  jest.advanceTimersByTime(59_999);
  expect(native.releasePreparedDictation).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(native.releasePreparedDictation).toHaveBeenCalledTimes(1);
});

it('releases immediately in the background and prepares again on foreground', async () => {
  retain();
  await flush();
  state('background');
  expect(native.releasePreparedDictation).toHaveBeenCalledTimes(1);
  state('active');
  await flush();
  expect(native.prepareDictation).toHaveBeenCalledTimes(2);
});

it('does not resurrect a preparation after blur during locale selection', async () => {
  let resolve!: (tags: string[]) => void;
  native.dictationLocales.mockImplementationOnce(
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const dispose = retain();
  dispose();
  disposers = [];
  resolve(['en-US']);
  await flush();
  expect(native.prepareDictation).not.toHaveBeenCalled();
});

it('prepares after refocus while an invalidated locale request is still pending', async () => {
  let resolve!: (tags: string[]) => void;
  native.dictationLocales.mockImplementationOnce(
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const dispose = retain();
  dispose();
  retain();
  await flush();
  expect(native.prepareDictation).toHaveBeenCalledTimes(1);
  expect(native.prepareDictation).toHaveBeenCalledWith('en-US');
  resolve(['en-US']);
  await flush();
  expect(native.prepareDictation).toHaveBeenCalledTimes(1);
});

it('switches language and does not prepare while initially backgrounded', async () => {
  const dispose = retain();
  await flush();
  retain(['de-DE']);
  await flush();
  expect(native.releasePreparedDictation).toHaveBeenCalled();
  expect(native.prepareDictation).toHaveBeenLastCalledWith('de-DE');
  dispose();
  state('background');
  retain(['en-US']);
  await flush();
  expect(native.prepareDictation).toHaveBeenCalledTimes(2);
});

it('aborts active dictation when the app leaves the foreground', async () => {
  retain();
  await flush();
  await voiceRecognition.startIOS('en-US');
  state('background');
  await flush();
  expect(native.stopDictation).toHaveBeenCalledWith(expect.any(String), true);
});

it('prepares only while the input is visible and never opens the microphone on focus', async () => {
  const hook = renderHook<ReturnType<typeof useVoiceInput>, { visible: boolean }>(
    ({ visible }) => useVoiceInput('', jest.fn(), undefined, { visible }),
    {
      initialProps: { visible: false },
    },
  );
  await flush();
  expect(native.prepareDictation).not.toHaveBeenCalled();
  await act(async () => {
    hook.rerender({ visible: true });
    await flush();
  });
  expect(native.prepareDictation).toHaveBeenCalledTimes(1);
  expect(native.startDictation).not.toHaveBeenCalled();
  act(() => hook.rerender({ visible: false }));
  jest.advanceTimersByTime(60_000);
  expect(native.releasePreparedDictation).toHaveBeenCalledTimes(1);
  hook.unmount();
});

it('requires the updated native bridge before starting a recording', async () => {
  const prepare = native.prepareDictation;
  try {
    // An OTA update must not call the changed native signature on an older build.
    native.prepareDictation = undefined as unknown as jest.Mock;
    await expect(voiceRecognition.startIOS('en-US')).rejects.toThrow(/new native app build/);
    expect(native.startDictation).not.toHaveBeenCalled();
  } finally {
    native.prepareDictation = prepare;
  }
});

it('keeps an explicit start alive while a permission dialog makes the app inactive', async () => {
  retain();
  await flush();
  await voiceRecognition.startIOS('en-US');
  state('inactive');
  expect(native.stopDictation).not.toHaveBeenCalled();
  expect(native.releasePreparedDictation).not.toHaveBeenCalled();
  voiceRecognition.abort();
  await flush();
});

it('keeps the shared reserve when one of two same-language inputs closes', async () => {
  const first = retain();
  retain();
  await flush();
  first();
  await flush();
  expect(native.releasePreparedDictation).not.toHaveBeenCalled();
  expect(native.prepareDictation).toHaveBeenCalledTimes(1);
});
