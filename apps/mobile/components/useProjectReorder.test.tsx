import { act, renderHook } from '@testing-library/react-native';
import { AppState, type View } from 'react-native';
import { measure, scrollTo, type AnimatedRef } from 'react-native-reanimated';
import { useProjectReorder, useProjectRowDrag } from './useProjectReorder';

let mockFrame: (frame: { timeSincePreviousFrame: number }) => void;
jest.mock('react-native-reanimated', () => {
  const { useRef } = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual('react-native-reanimated/mock'),
    useReducedMotion: () => false,
    measure: jest.fn(),
    scrollTo: jest.fn(),
    useAnimatedRef: () => useRef({ current: null }).current,
    useSharedValue: <T,>(value: T) => useRef({ value }).current,
    useDerivedValue: <T,>(processor: () => T) => {
      const latest = useRef(processor);
      latest.current = processor;
      return useRef({
        get value() {
          return latest.current();
        },
      }).current;
    },
    useAnimatedScrollHandler: (handler: unknown) => handler,
    useFrameCallback: (handler: typeof mockFrame) => {
      mockFrame = handler;
    },
  };
});
jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Medium: 'medium' },
  impactAsync: jest.fn(() => Promise.resolve()),
}));
const order = ['control', 'a', 'b', 'c'];
const rect = (pageY: number, height = 60) => ({ x: 0, y: 0, pageX: 20, pageY, width: 300, height });

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function setup(id = 'c', top = 280, initialOrder = order, visibleIds = initialOrder) {
  const onDrop = jest.fn();
  const hook = renderHook(() =>
    useProjectReorder({
      order: initialOrder,
      sortable: initialOrder.filter((key) => key !== 'control'),
      onDrop,
    }),
  );
  const refs = visibleIds.map((key) => ({
    id: key,
    row: {} as AnimatedRef<View>,
    handle: {} as AnimatedRef<View>,
    slot: {} as AnimatedRef<View>,
  }));
  let unregister = () => {};
  let scrollY = 0;
  act(() => {
    for (const entry of refs) {
      const remove = hook.result.current.register(entry);
      if (entry.id === id) unregister = remove;
      hook.result.current.reportCompactHeight(entry.id, 60);
    }
    hook.result.current.onViewportLayout(600);
  });
  jest.mocked(measure).mockImplementation((ref) => {
    if (Object.is(ref, hook.result.current.hostRef)) return rect(100, 600);
    const index = refs.findIndex((entry) => Object.is(ref, entry.slot));
    if (index >= 0) return rect(100 + index * 60 - scrollY);
    const picked = refs.find((entry) => entry.id === id)!;
    return Object.is(ref, picked.row)
      ? rect(top, 300)
      : Object.is(ref, picked.handle)
        ? rect(top)
        : null;
  });
  const start = () =>
    act(() =>
      hook.result.current.gesture.handlers.onStart?.({
        absoluteX: 100,
        absoluteY: top + 20,
      } as never),
    );
  const move = (absoluteY: number) =>
    act(() =>
      hook.result.current.gesture.handlers.onUpdate?.({ absoluteX: 100, absoluteY } as never),
    );
  const end = (success = true) =>
    act(() => hook.result.current.gesture.handlers.onFinalize?.({} as never, success));
  const scroll = (y: number) => {
    scrollY = y;
    act(() => hook.result.current.onScroll({ contentOffset: { y } } as never));
  };
  const style = () => {
    hook.rerender({});
    return hook.result.current.overlayStyle;
  };
  return { hook, onDrop, start, move, end, scroll, style, unregister: () => act(unregister) };
}

it('keeps a bottom pickup at its screen position across collapse, recycling and continued movement', () => {
  const test = setup();
  test.scroll(900);
  test.start();
  expect(test.hook.result.current.draggingId).toBe('c');
  expect(test.style()).toMatchObject({ top: 180, left: 0, width: 300, opacity: 1 });
  // The real list may discard every measured cell after its content shrinks.
  const viewportGesture = test.hook.result.current.gesture;
  test.unregister();
  expect(test.hook.result.current.gesture).toBe(viewportGesture);
  test.scroll(0);
  expect(test.style()).toMatchObject({ top: 180 });
  test.move(180);
  expect(test.style()).toMatchObject({ top: 180, transform: [{ translateY: -120 }] });
  expect(test.hook.result.current.drag.value?.order).toEqual(['control', 'c', 'a', 'b']);
  test.end();
  expect(test.onDrop).toHaveBeenCalledWith(['control', 'c', 'a', 'b']);
  expect(test.hook.result.current.draggingId).toBeNull();
  expect(test.style()).toMatchObject({ opacity: 0 });
  test.end();
  expect(test.onDrop).toHaveBeenCalledTimes(1);
});

it('preserves the grab point for a top pickup while the list moves underneath it', () => {
  const test = setup('a', 160);
  test.start();
  test.scroll(25);
  expect(test.style()).toMatchObject({ top: 60 });
  test.move(270);
  expect(test.style()).toMatchObject({ top: 60, transform: [{ translateY: 90 }] });
  test.end();
  expect(test.onDrop).toHaveBeenCalledWith(['control', 'b', 'c', 'a']);
});

it('does not pick up pinned rows or a press outside the measured header', () => {
  const pinned = setup('control');
  pinned.start();
  expect(pinned.hook.result.current.draggingId).toBeNull();
  pinned.hook.unmount();
  const test = setup();
  jest.mocked(measure).mockReturnValue(null);
  test.start();
  expect(test.hook.result.current.draggingId).toBeNull();
});

it('unlocks after cancellation without saving and allows the next pickup', () => {
  const test = setup();
  test.start();
  test.move(180);
  test.end(false);
  expect(test.onDrop).not.toHaveBeenCalled();
  expect(test.hook.result.current.draggingId).toBeNull();
  test.start();
  expect(test.hook.result.current.draggingId).toBe('c');
  test.end();
  expect(test.onDrop).toHaveBeenCalledTimes(1);
});

it('recovers a lost native finalize after the last touch ends', () => {
  const test = setup();
  test.start();
  act(() => test.hook.result.current.gesture.handlers.onTouchesUp?.({} as never, {} as never));
  act(() => jest.advanceTimersByTime(250));
  expect(test.hook.result.current.draggingId).toBeNull();
  expect(test.onDrop).not.toHaveBeenCalled();
  test.start();
  expect(test.hook.result.current.draggingId).toBe('c');
});

it('does not let an old release timeout cancel a newer pickup', () => {
  const test = setup();
  test.start();
  act(() => test.hook.result.current.gesture.handlers.onTouchesUp?.({} as never, {} as never));
  test.end();
  test.start();
  act(() => jest.advanceTimersByTime(250));
  expect(test.hook.result.current.draggingId).toBe('c');
});

it('cancels when the app backgrounds instead of leaving a locked list on return', () => {
  const subscribe = jest.spyOn(AppState, 'addEventListener');
  const test = setup();
  test.start();
  act(() => subscribe.mock.calls.at(-1)![1]('background'));
  expect(test.hook.result.current.draggingId).toBeNull();
  expect(test.onDrop).not.toHaveBeenCalled();
});

it('scrolls toward offscreen destinations without moving the overlay', () => {
  const test = setup('c', 650);
  test.start();
  act(() => test.hook.result.current.onContentSizeChange(300, 1200));
  act(() => mockFrame({ timeSincePreviousFrame: 16 }));
  expect(scrollTo).toHaveBeenCalledWith(test.hook.result.current.listRef, 0, 7.2, false);
  test.scroll(7.2);
  expect(test.style()).toMatchObject({ top: 550 });
  act(() => test.hook.result.current.onContentSizeChange(300, 480));
  jest.mocked(scrollTo).mockClear();
  test.scroll(0);
  act(() => mockFrame({ timeSincePreviousFrame: 16 }));
  expect(scrollTo).not.toHaveBeenCalled();
});

it('uses a hidden slot for the selected row and a visible independent copy', () => {
  const test = setup();
  test.start();
  const row = renderHook(
    ({ floating }: { floating: boolean }) =>
      useProjectRowDrag({
        id: 'c',
        reorder: test.hook.result.current,
        renderedOrder: order,
        enabled: false,
        floating,
      }),
    { initialProps: { floating: false } },
  );
  expect(row.result.current.style).toMatchObject({ opacity: 0 });
  row.rerender({ floating: true });
  expect(row.result.current.style).toMatchObject({ opacity: 1 });
});

it('leaves session content and header actions to their own gestures', () => {
  const test = setup();
  const fail = jest.fn();
  const down = (absoluteY: number) =>
    act(() =>
      test.hook.result.current.gesture.handlers.onTouchesDown?.(
        { allTouches: [{ absoluteX: 100, absoluteY }] } as never,
        { fail } as never,
      ),
    );
  down(300);
  expect(fail).not.toHaveBeenCalled();
  down(400);
  expect(fail).toHaveBeenCalledTimes(1);
});

it('uses visible slot measurements even when earlier rows have never mounted', () => {
  const longOrder = ['control', ...Array.from({ length: 80 }, (_, index) => `p${index}`)];
  const test = setup('p79', 280, longOrder, ['p40', 'p41', 'p79']);
  test.start();
  test.move(180);
  test.end();
  const saved = test.onDrop.mock.calls[0]![0] as string[];
  expect(saved.indexOf('p79')).toBe(longOrder.indexOf('p41'));
  expect(saved[saved.indexOf('p79') + 1]).toBe('p41');
  expect(saved.filter((id) => id !== 'p79')).toEqual(longOrder.filter((id) => id !== 'p79'));
});
