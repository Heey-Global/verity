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
  act(() => hook.result.current.finish(dropped));
  expect(onDrop).toHaveBeenCalledTimes(1);
  expect(onDrop).toHaveBeenCalledWith(dropped);
  expect(hook.result.current.draggingId).toBeNull();
  // Forgotten only once the slot springs have settled across the commit.
  expect(hook.result.current.drag.value).not.toBeNull();
  act(() => jest.advanceTimersByTime(PROJECT_DRAG_FORGET_MS));
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
