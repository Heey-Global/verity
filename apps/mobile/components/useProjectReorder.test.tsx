import { act, render, renderHook } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { GestureDetector } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import Reanimated, { useReducedMotion } from 'react-native-reanimated';

import {
  PROJECT_DRAG_FORGET_MS,
  PROJECT_DROP_WATCHDOG_MS,
  useProjectReorder,
  useProjectRowDrag,
} from './useProjectReorder';

jest.mock('react-native-reanimated', () => {
  const { useRef } = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual('react-native-reanimated/mock'),
    useReducedMotion: jest.fn(() => false),
    useAnimatedScrollHandler: (handlers: { onScroll: unknown }) => handlers.onScroll,
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

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(Haptics.impactAsync).mockClear();
});
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
  act(() => hook.result.current.finish(dropped, 1));
  expect(onDrop).toHaveBeenCalledTimes(1);
  expect(onDrop).toHaveBeenCalledWith(dropped);
  expect(hook.result.current.draggingId).toBeNull();
  // Forgotten only once the slot springs have settled across the commit.
  expect(hook.result.current.drag.value).not.toBeNull();
  act(() => jest.advanceTimersByTime(PROJECT_DRAG_FORGET_MS));
  expect(hook.result.current.drag.value).toBeNull();

  act(() => hook.result.current.finish(dropped, 1));
  act(() => jest.advanceTimersByTime(PROJECT_DROP_WATCHDOG_MS));
  expect(onDrop).toHaveBeenCalledTimes(1);
});

// A drop animation that never reports back (its value replaced, its node gone)
// used to leave the overview folded with no way out; the watchdog commits it.
it('commits a drop whose animation never reports back', () => {
  const { hook, onDrop } = controller();
  act(() => hook.result.current.begin('a'));
  act(() => hook.result.current.armWatchdog(order, 1));
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

describe('row gesture', () => {
  let latest: ReturnType<typeof useProjectReorder> | null = null;
  function Row({ id, onDrop }: { id: string; onDrop: (order: readonly string[]) => void }) {
    const reorder = useProjectReorder({ order, sortable, onDrop });
    latest = reorder;
    const { gesture, style } = useProjectRowDrag({
      id,
      reorder,
      renderedOrder: order,
      enabled: true,
    });
    return (
      <GestureDetector gesture={gesture}>
        <Reanimated.View style={style} />
      </GestureDetector>
    );
  }

  afterEach(() => {
    latest = null;
    jest.mocked(useReducedMotion).mockReturnValue(false);
  });

  // The test driver always releases the finger at the end of a sequence, so
  // this covers a whole pickup, move and drop through the gesture callbacks.
  it('picks the row up on activation, glides it into its slot and commits once', () => {
    const onDrop = jest.fn();
    render(<Row id="a" onDrop={onDrop} />);
    act(() => {
      for (const id of order) latest!.reportCompactHeight(id, 60);
    });
    act(() =>
      fireGestureHandler(getByGestureTestId('project-drag:a'), [
        { translationY: 0 },
        { translationY: 500 },
      ]),
    );
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(latest!.drag.value).toMatchObject({ id: 'a', dropping: true });
    expect(latest!.travel.value).toBe(0);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(order);
    expect(latest!.draggingId).toBeNull();
    act(() => jest.advanceTimersByTime(PROJECT_DROP_WATCHDOG_MS));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(latest!.drag.value).toBeNull();
  });

  it('drops without a glide when the platform asks for reduced motion', () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    const onDrop = jest.fn();
    render(<Row id="b" onDrop={onDrop} />);
    act(() => fireGestureHandler(getByGestureTestId('project-drag:b'), [{ translationY: 30 }]));
    expect(onDrop).toHaveBeenCalledWith(order);
    expect(latest!.travel.value).toBe(0);
    expect(latest!.draggingId).toBeNull();
  });
});

// JS pickup can precede propagation of its shared value to the UI thread.
// Finalizing against the retained previous drop must still unlock the list.
it('releases a same-row pickup when finalize still sees the previous drop', () => {
  const { hook, onDrop } = controller();
  act(() => hook.result.current.begin('a'));
  const previous = { ...hook.result.current.drag.value!, dropping: true };
  act(() => hook.result.current.finish(order, 1));
  act(() => hook.result.current.begin('a'));
  const row = renderHook(() =>
    useProjectRowDrag({
      id: 'a',
      reorder: hook.result.current,
      renderedOrder: order,
      enabled: true,
    }),
  );
  act(() => {
    hook.result.current.drag.value = previous;
    row.result.current.gesture.handlers.onFinalize?.({} as never, true);
  });
  expect(hook.result.current.draggingId).toBeNull();
  expect(onDrop).toHaveBeenCalledTimes(2);
  act(() => hook.result.current.begin('b'));
  expect(hook.result.current.draggingId).toBe('b');
});

it('ignores a previous animation completion after the watchdog allows a new pickup', () => {
  const { hook, onDrop } = controller();
  act(() => hook.result.current.begin('a'));
  const token = hook.result.current.drag.value!.token!;
  act(() => hook.result.current.armWatchdog(order, token));
  act(() => jest.advanceTimersByTime(PROJECT_DROP_WATCHDOG_MS));
  act(() => hook.result.current.begin('b'));
  act(() => hook.result.current.finish(order, token));
  expect(hook.result.current.draggingId).toBe('b');
  expect(onDrop).toHaveBeenCalledTimes(1);
});

it('keeps the last row at the finger after expanded groups above collapse', () => {
  const { hook } = controller();
  act(() => {
    for (const id of order) hook.result.current.reportCompactHeight(id, 60);
    hook.result.current.reportExpandedHeight('a', 260);
    hook.result.current.begin('c');
  });
  const row = renderHook(() =>
    useProjectRowDrag({
      id: 'c',
      reorder: hook.result.current,
      renderedOrder: order,
      enabled: true,
    }),
  );
  act(() => row.result.current.gesture.handlers.onUpdate?.({ translationY: 12 } as never));
  expect(hook.result.current.shift.value + hook.result.current.travel.value).toBe(212);
});

// Native content shrink changes the scroll offset without a pointer move.
// Ignoring it leaves a bottom-row pickup below the visible viewport.
it('compensates native scroll clamping while the expanded list folds', () => {
  const { hook } = controller();
  const scroll = (y: number) =>
    act(() => hook.result.current.onScroll({ contentOffset: { y } } as never));
  scroll(900);
  act(() => {
    for (const id of order) hook.result.current.reportCompactHeight(id, 60);
    hook.result.current.reportExpandedHeight('a', 660);
    hook.result.current.reportExpandedHeight('b', 360);
    hook.result.current.begin('c');
  });
  const expandedTop = 1080;
  const compactTop = 180;
  const pickupScreenY = expandedTop - 900;
  expect(compactTop + hook.result.current.shift.value - 900).toBe(pickupScreenY);
  scroll(0);
  expect(compactTop + hook.result.current.shift.value).toBe(pickupScreenY);
  act(() => {
    hook.result.current.travel.value = -45;
  });
  scroll(20);
  expect(compactTop + hook.result.current.shift.value + hook.result.current.travel.value - 20).toBe(
    pickupScreenY - 45,
  );

  // Once released, the slot animation owns compensation, not later scrolls.
  act(() => {
    hook.result.current.drag.value = { ...hook.result.current.drag.value!, dropping: true };
  });
  const dropShift = hook.result.current.shift.value;
  scroll(0);
  expect(hook.result.current.shift.value).toBe(dropShift);
});
