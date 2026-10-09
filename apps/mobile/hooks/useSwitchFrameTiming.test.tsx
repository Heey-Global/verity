import { AppState } from 'react-native';
import { renderHook, act } from '@testing-library/react-native';
import { beginSessionSwitch } from '@verity/mobile';
import { markInitialListLoad } from '../lib/sessionSwitchTiming';
import { useSwitchFrameTiming } from './useSwitchFrameTiming';
beforeEach(() => {
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
