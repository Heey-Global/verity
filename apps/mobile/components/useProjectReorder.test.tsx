import { act, renderHook } from '@testing-library/react-native';

import {
  PROJECT_DROP_WATCHDOG_MS,
  useProjectReorder,
  useProjectRowDrag,
} from './useProjectReorder';

jest.mock('react-native-reanimated', () => {
  const { useRef } = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual('react-native-reanimated/mock'),
    useReducedMotion: jest.fn(() => false),
    // The shipped mock creates a fresh shared value on every render, which
    // would hide the drag state from the very re-render that pickup triggers.
    useSharedValue: <T,>(init: T) => useRef({ value: init }).current,
  };
});
jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Medium: 'medium' },
  impactAsync: jest.fn(() => Promise.resolve()),
}));

const order = ['control', 'a', 'b', 'c'];
const sortable = ['a', 'b', 'c'];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function controller(onDrop = jest.fn()) {
  const hook = renderHook(() => useProjectReorder({ order, sortable, onDrop }));
  return { hook, onDrop };
}

it('folds the groups at pickup and commits the dropped order exactly once', () => {
  const { hook, onDrop } = controller();
  act(() => hook.result.current.begin('b'));
  expect(hook.result.current.draggingId).toBe('b');
  expect(hook.result.current.drag.value).toMatchObject({
    id: 'b',
    startOrder: order,
    order,
    range: { min: 1, max: 3 },
  });

  const dropped = ['control', 'b', 'a', 'c'];
  act(() => hook.result.current.finish(dropped));
  expect(onDrop).toHaveBeenCalledTimes(1);
  expect(onDrop).toHaveBeenCalledWith(dropped);
  expect(hook.result.current.draggingId).toBeNull();
  // Forgotten only after the commit rendered, never before it.
  expect(hook.result.current.drag.value).toBeNull();

  act(() => hook.result.current.finish(dropped));
  act(() => jest.advanceTimersByTime(PROJECT_DROP_WATCHDOG_MS));
  expect(onDrop).toHaveBeenCalledTimes(1);
});

// A drop animation that never reports back (its value replaced, its node gone)
// used to leave the overview folded with no way out; the watchdog commits it.
it('commits a drop whose animation never reports back', () => {
  const { hook, onDrop } = controller();
  act(() => hook.result.current.begin('a'));
  act(() => hook.result.current.armWatchdog(order));
  act(() => jest.advanceTimersByTime(PROJECT_DROP_WATCHDOG_MS - 1));
  expect(onDrop).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(onDrop).toHaveBeenCalledWith(order);
  expect(hook.result.current.draggingId).toBeNull();
});

it('ignores a second pickup while a drag is live and rows it does not render', () => {
  const { hook } = controller();
  act(() => hook.result.current.begin('missing'));
  expect(hook.result.current.draggingId).toBeNull();
  act(() => hook.result.current.begin('a'));
  act(() => hook.result.current.begin('b'));
  expect(hook.result.current.draggingId).toBe('a');
});

it('lets go of a pickup whose gesture ended before the pickup reached the JS thread', () => {
  const { hook, onDrop } = controller();
  act(() => hook.result.current.cancelPickup('a'));
  expect(onDrop).not.toHaveBeenCalled();
  act(() => hook.result.current.begin('a'));
  act(() => hook.result.current.cancelPickup('b'));
  expect(hook.result.current.draggingId).toBe('a');
  act(() => hook.result.current.cancelPickup('a'));
  expect(onDrop).toHaveBeenCalledWith(order);
  expect(hook.result.current.draggingId).toBeNull();
});

it('adds the height the folding groups above lose, so the row stays under the finger', () => {
  const { hook } = controller();
  act(() => {
    for (const id of order) hook.result.current.reportCompactHeight(id, 60);
    hook.result.current.reportExpandedHeight('a', 260);
    hook.result.current.reportExpandedHeight('control', 60);
  });
  act(() => hook.result.current.begin('c'));
  expect(hook.result.current.shift.value).toBe(200);
  expect(hook.result.current.offset.value).toBe(200);
});

it('gives every row a gesture and a transform that is idle at rest', () => {
  const { hook } = controller();
  const row = renderHook(() =>
    useProjectRowDrag({
      id: 'a',
      reorder: hook.result.current,
      renderedOrder: order,
      enabled: true,
    }),
  );
  expect(row.result.current.gesture).toBeDefined();
  expect(row.result.current.style).toEqual({
    transform: [{ translateY: 0 }, { scale: 1 }],
  });
});
