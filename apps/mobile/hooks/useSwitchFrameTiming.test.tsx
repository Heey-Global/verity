import { setGestureDiagnosticsEnabled } from '../lib/gestureDiagnostics';
import { AppState, type AppStateStatus } from 'react-native';
import { renderHook, act } from '@testing-library/react-native';
import { beginSessionSwitch } from '@verity/mobile';
import { markInitialListLoad } from '../lib/sessionSwitchTiming';
import { useSwitchFrameTiming } from './useSwitchFrameTiming';
beforeEach(() => {
  setGestureDiagnosticsEnabled(true);
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
});
const mockSetActive = jest.fn();
let mockCallback: (info: { timeSincePreviousFrame: number | null }) => void;
const mockFrame = { setActive: mockSetActive };
jest.mock('react-native-reanimated', () => {
  const { useRef } = jest.requireActual('react');
  return {
    useSharedValue: (value: number) => useRef({ value }).current,
    runOnJS: (fn: unknown) => fn,
    runOnUI: (fn: unknown) => fn,
    useFrameCallback: (callback: typeof mockCallback) => {
      mockCallback = callback;
      return mockFrame;
    },
  };
});
it('reports UI frame gaps with bounded delivery and stops on list completion', () => {
  jest.useFakeTimers();
  const trace = beginSessionSwitch('frames');
  const hook = renderHook(() => useSwitchFrameTiming(trace));
  act(() => {
    mockCallback({ timeSincePreviousFrame: null });
    mockCallback({ timeSincePreviousFrame: 200 });
    expect(trace.phases).toHaveLength(0);
    mockCallback({ timeSincePreviousFrame: 400 });
  });
  expect(trace.phases.find((p) => p.phase === 'ui-frame-gap-max-ms')?.value).toBe(400);
  markInitialListLoad(trace);
  act(() => jest.advanceTimersByTime(250));
  expect(mockSetActive).toHaveBeenLastCalledWith(false);
  expect(jest.getTimerCount()).toBe(0);
  const before = JSON.stringify(trace.phases);
  act(() => mockCallback({ timeSincePreviousFrame: 900 }));
  // An already queued sample from the completed switch remains attributable.
  expect(trace.phases.find((p) => p.phase === 'ui-frame-gap-max-ms')?.value).toBe(900);
  expect(JSON.stringify(trace.phases)).not.toBe(before);
  hook.unmount();
  jest.useRealTimers();
});

it('flushes a gap before the first periodic report', () => {
  jest.useFakeTimers();
  const trace = beginSessionSwitch('short');
  const hook = renderHook<void, { completed: boolean }>(
    ({ completed }) => useSwitchFrameTiming(trace, completed),
    {
      initialProps: { completed: false },
    },
  );
  act(() => mockCallback({ timeSincePreviousFrame: 300 }));
  expect(trace.phases).toEqual([]);
  markInitialListLoad(trace);
  hook.rerender({ completed: true });
  expect(trace.phases.find((p) => p.phase === 'ui-frame-gap-max-ms')?.value).toBe(300);
  hook.unmount();
  jest.useRealTimers();
});

it('retains the UI frame callback across unrelated chat renders', () => {
  jest.useFakeTimers();
  const trace = beginSessionSwitch('stable');
  const hook = renderHook(() => useSwitchFrameTiming(trace));
  const before = mockCallback;
  hook.rerender(undefined);
  expect(mockCallback).toBe(before);
  hook.unmount();
  jest.useRealTimers();
});

afterEach(() => setGestureDiagnosticsEnabled(false));

it('keeps frames and polling off until recording is enabled and rejects old delivery', () => {
  jest.useFakeTimers();
  setGestureDiagnosticsEnabled(false);
  const trace = beginSessionSwitch('off');
  const hook = renderHook(() => useSwitchFrameTiming(trace));
  expect(mockSetActive).toHaveBeenLastCalledWith(false);
  expect(jest.getTimerCount()).toBe(0);
  act(() => setGestureDiagnosticsEnabled(true));
  expect(mockSetActive).toHaveBeenLastCalledWith(true);
  const oldCallback = mockCallback;
  act(() => {
    setGestureDiagnosticsEnabled(false);
    expect(mockSetActive).toHaveBeenLastCalledWith(false);
    expect(jest.getTimerCount()).toBe(0);
  });
  expect(mockSetActive).toHaveBeenLastCalledWith(false);
  expect(jest.getTimerCount()).toBe(0);
  act(() => setGestureDiagnosticsEnabled(true));
  act(() => oldCallback({ timeSincePreviousFrame: 900 }));
  expect(trace.phases).toEqual([]);
  act(() => mockCallback({ timeSincePreviousFrame: 600 }));
  expect(trace.phases.find((p) => p.phase === 'ui-frame-gap-max-ms')?.value).toBe(600);
  hook.unmount();
  jest.useRealTimers();
});

it('creates no polling timer without an open switch', () => {
  jest.useFakeTimers();
  const hook = renderHook(() => useSwitchFrameTiming(undefined));
  expect(mockSetActive).toHaveBeenLastCalledWith(false);
  expect(jest.getTimerCount()).toBe(0);
  hook.unmount();
  jest.useRealTimers();
});

it('resumes a new generation when off and on are batched', () => {
  jest.useFakeTimers();
  const trace = beginSessionSwitch('batched');
  const hook = renderHook(() => useSwitchFrameTiming(trace));
  const oldCallback = mockCallback;
  act(() => {
    setGestureDiagnosticsEnabled(false);
    expect(jest.getTimerCount()).toBe(0);
    setGestureDiagnosticsEnabled(true);
  });
  expect(mockSetActive).toHaveBeenLastCalledWith(true);
  expect(jest.getTimerCount()).toBe(1);
  expect(mockCallback).not.toBe(oldCallback);
  act(() => oldCallback({ timeSincePreviousFrame: 900 }));
  expect(trace.phases).toEqual([]);
  act(() => mockCallback({ timeSincePreviousFrame: 600 }));
  expect(trace.phases.find((p) => p.phase === 'ui-frame-gap-max-ms')?.value).toBe(600);
  hook.unmount();
  jest.useRealTimers();
});

it('stops frame polling immediately on background and removes its listener on unmount', () => {
  jest.useFakeTimers();
  let change!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  const listener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_, callback) => {
    change = callback;
    return { remove };
  });
  const hook = renderHook(() => useSwitchFrameTiming(beginSessionSwitch('background')));
  try {
    expect(jest.getTimerCount()).toBe(1);
    act(() => change('background'));
    expect(mockSetActive).toHaveBeenLastCalledWith(false);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    hook.unmount();
    expect(remove).toHaveBeenCalled();
    listener.mockRestore();
    jest.useRealTimers();
  }
});
