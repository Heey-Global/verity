import { act, renderHook } from '@testing-library/react-native';
import { AppState, type View } from 'react-native';
import { measure, scrollTo, withSpring, type AnimatedRef } from 'react-native-reanimated';
import { useProjectReorder, useProjectRowDrag, useSessionDragOrder } from './useProjectReorder';

let mockFrame: (frame: { timeSincePreviousFrame: number }) => void;
jest.mock('react-native-reanimated', () => {
  const { useRef } = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual('react-native-reanimated/mock'),
    useReducedMotion: () => false,
    withSpring: jest.fn((value: number) => value),
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
    useAnimatedStyle: (processor: () => Record<string, unknown>) => {
      const latest = useRef(processor);
      latest.current = processor;
      return useRef(
        new Proxy(
          {},
          {
            get: (_target, key) => latest.current()[key as string],
            ownKeys: () => Reflect.ownKeys(latest.current()),
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
          },
        ),
      ).current;
    },
    useAnimatedScrollHandler: (handler: unknown) => useRef(handler).current,
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

// An unfinished spring must not survive the layout move and displace the row
// for a second time. Model the residual rather than making springs immediate.
it('removes a neighbour displacement in the same render that commits its new slot', () => {
  const test = setup('a', 160);
  test.start();
  test.move(300);
  jest.mocked(withSpring).mockImplementation((value) => Number(value) - 15);
  const row = renderHook(
    ({ renderedOrder }: { renderedOrder: readonly string[] }) =>
      useProjectRowDrag({
        id: 'b',
        reorder: test.hook.result.current,
        renderedOrder,
        enabled: false,
      }),
    { initialProps: { renderedOrder: order } },
  );
  expect(row.result.current.style).toMatchObject({ transform: [{ translateY: -75 }] });
  const dropped = test.hook.result.current.drag.value!.order;
  act(() => {
    test.hook.result.current.drag.value = {
      ...test.hook.result.current.drag.value!,
      dropping: true,
    };
  });
  row.rerender({ renderedOrder: dropped });
  expect(row.result.current.style).toMatchObject({ transform: [{ translateY: 0 }] });
  act(() => {
    test.hook.result.current.drag.value = null;
  });
  row.rerender({ renderedOrder: dropped });
  expect(row.result.current.style).toMatchObject({ transform: [{ translateY: 0 }] });
  jest.mocked(withSpring).mockImplementation((value) => value);
});

function setupSessions() {
  const onDrop = jest.fn();
  const onDropSession = jest.fn();
  let sessionOrders = { 'project-a': ['session:a', 'session:b'], 'project-b': ['session:c'] };
  const hook = renderHook(() =>
    useProjectReorder({
      order: ['project-a', 'project-b'],
      sortable: ['project-a', 'project-b'],
      onDrop,
      sessionOrders,
      onDropSession,
    }),
  );
  const entries = [
    { id: 'project-a', top: 100, scope: undefined },
    { id: 'session:a', top: 160, scope: 'project-a' },
    { id: 'session:b', top: 220, scope: 'project-a' },
    { id: 'project-b', top: 280, scope: undefined },
    { id: 'session:c', top: 340, scope: 'project-b' },
  ].map(({ scope, ...entry }) => ({
    ...entry,
    ...(scope ? { scope } : {}),
    row: {} as AnimatedRef<View>,
    handle: {} as AnimatedRef<View>,
    slot: {} as AnimatedRef<View>,
  }));
  act(() => {
    entries.forEach((entry) => {
      hook.result.current.register(entry);
      hook.result.current.reportCompactHeight(entry.id, 60);
    });
    hook.result.current.onViewportLayout(600);
  });
  jest.mocked(measure).mockImplementation((ref) => {
    if (Object.is(ref, hook.result.current.hostRef)) return rect(100, 600);
    const entry = entries.find((entry) =>
      [entry.handle, entry.row, entry.slot].some((candidate) => Object.is(candidate, ref)),
    );
    if (!entry) return null;
    // Action/link areas are outside the title's hit rectangle.
    return Object.is(ref, entry.handle)
      ? { ...rect(entry.top), width: 180, height: 19 }
      : rect(entry.top);
  });
  const start = (y = 225) =>
    act(() =>
      hook.result.current.gesture.handlers.onStart?.({ absoluteX: 100, absoluteY: y } as never),
    );
  const move = (y: number) =>
    act(() =>
      hook.result.current.gesture.handlers.onUpdate?.({ absoluteX: 100, absoluteY: y } as never),
    );
  const end = (success = true) =>
    act(() => hook.result.current.gesture.handlers.onFinalize?.({} as never, success));
  const refreshOrder = () => {
    sessionOrders = { ...sessionOrders, 'project-a': ['session:b', 'session:a'] };
    hook.rerender({});
  };
  return { hook, onDrop, onDropSession, start, move, end, refreshOrder };
}

it('does not enable manual sorting for an unchanged pickup, but saves a move against the frozen order', () => {
  const test = setupSessions();
  test.start();
  test.end();
  expect(test.onDropSession).not.toHaveBeenCalled();
  test.start();
  test.refreshOrder();
  test.move(165);
  const picked = renderHook(() =>
    useProjectRowDrag({
      id: 'session:b',
      scope: 'project-a',
      reorder: test.hook.result.current,
      renderedOrder: ['session:a', 'session:b'],
      enabled: false,
    }),
  );
  act(() =>
    test.hook.result.current.confirmSessionOverlay(test.hook.result.current.sessionDragToken!),
  );
  picked.rerender({});
  expect(picked.result.current.style).toMatchObject({
    opacity: 0,
    transform: [{ translateY: -60 }],
  });
  expect(picked.result.current.placeholderStyle).toMatchObject({
    transform: [{ translateY: -60 }],
  });
  test.end();
  expect(test.onDropSession).toHaveBeenCalledWith('project-a', ['session:b', 'session:a']);
});

it('moves sessions only within the picked project and never saves a project order', () => {
  const test = setupSessions();
  test.start();
  expect(test.hook.result.current.draggingId).toBeNull();
  expect(test.hook.result.current.draggingSessionId).toBe('session:b');
  test.move(105);
  expect(test.hook.result.current.drag.value?.order).toEqual(['session:b', 'session:a']);
  test.move(400);
  expect(test.hook.result.current.drag.value?.order).toEqual(['session:a', 'session:b']);
  test.move(165);
  test.end();
  expect(test.onDropSession).toHaveBeenCalledWith('project-a', ['session:b', 'session:a']);
  expect(test.onDrop).not.toHaveBeenCalled();
  expect(test.hook.result.current.draggingSessionId).toBeNull();
});

it('keeps other projects and their sessions stationary during a session drag', () => {
  const test = setupSessions();
  test.start();
  test.move(165);
  const project = renderHook(() =>
    useProjectRowDrag({
      id: 'project-a',
      reorder: test.hook.result.current,
      renderedOrder: ['project-a', 'project-b'],
      enabled: false,
    }),
  );
  const otherSession = renderHook(() =>
    useProjectRowDrag({
      id: 'session:c',
      scope: 'project-b',
      reorder: test.hook.result.current,
      renderedOrder: ['session:c'],
      enabled: false,
    }),
  );
  expect(project.result.current.style).toMatchObject({
    opacity: 1,
    transform: [{ translateY: 0 }],
  });
  expect(otherSession.result.current.style).toMatchObject({
    opacity: 1,
    transform: [{ translateY: 0 }],
  });
  test.end(false);
  expect(test.onDropSession).not.toHaveBeenCalled();
});

it('leaves session links, status and sharing areas outside the drag handle', () => {
  const test = setupSessions();
  const fail = jest.fn();
  act(() =>
    test.hook.result.current.gesture.handlers.onTouchesDown?.(
      {
        allTouches: [{ absoluteX: 280, absoluteY: 225 }],
      } as never,
      { fail } as never,
    ),
  );
  expect(fail).toHaveBeenCalledTimes(1);
  test.start(247);
  expect(test.hook.result.current.draggingSessionId).toBeNull();
  test.start();
  // A second start cannot turn a session drag into a project drag.
  test.start(105);
  expect(test.hook.result.current.draggingId).toBeNull();
  expect(test.hook.result.current.draggingSessionId).toBe('session:b');
});

it('keeps the session visible until the measured overlay is ready and restores it on cancellation', () => {
  const test = setupSessions();
  test.start();
  const row = renderHook(() =>
    useProjectRowDrag({
      id: 'session:b',
      scope: 'project-a',
      reorder: test.hook.result.current,
      renderedOrder: ['session:a', 'session:b'],
      enabled: false,
    }),
  );
  expect(row.result.current.style).toMatchObject({ opacity: 1 });
  expect(test.hook.result.current.overlayStyle).toMatchObject({
    width: 300,
    height: 60,
    opacity: 1,
  });
  const token = test.hook.result.current.sessionDragToken!;
  act(() => test.hook.result.current.confirmSessionOverlay(token));
  row.rerender({});
  expect(row.result.current.style).toMatchObject({ opacity: 0 });
  test.end(false);
  row.rerender({});
  expect(row.result.current.style).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });
  act(() => test.hook.result.current.confirmSessionOverlay(token));
  test.start();
  row.rerender({});
  expect(row.result.current.style).toMatchObject({ opacity: 1 });
});

it('restores a hidden session after a drop and ignores a late overlay layout', () => {
  const test = setupSessions();
  test.start();
  const token = test.hook.result.current.sessionDragToken!;
  act(() => test.hook.result.current.confirmSessionOverlay(token));
  test.move(165);
  test.end();
  act(() => test.hook.result.current.confirmSessionOverlay(token));
  expect(test.hook.result.current.sessionOverlayReady.value).toBeNull();
  expect(test.hook.result.current.drag.value).toBeNull();
  const row = renderHook(() =>
    useProjectRowDrag({
      id: 'session:b',
      scope: 'project-a',
      reorder: test.hook.result.current,
      renderedOrder: ['session:b', 'session:a'],
      enabled: false,
    }),
  );
  expect(row.result.current.style).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });
});

it('preserves the session order input across unread and polling renders', () => {
  const first = [{ sessionId: 'a' }, { sessionId: 'b' }];
  const hook = renderHook(
    ({ sessions }: { sessions: { sessionId: string }[] }) => useSessionDragOrder(sessions),
    {
      initialProps: { sessions: first },
    },
  );
  const order = hook.result.current;
  hook.rerender({ sessions: first.map((session) => ({ ...session })) });
  expect(hook.result.current).toBe(order);
  hook.rerender({ sessions: [first[1]!, first[0]!] });
  expect(hook.result.current).not.toBe(order);
  expect(hook.result.current).toEqual(['session:b', 'session:a']);
});

it('preserves the controller identity on unrelated renders, but publishes drag changes', () => {
  const test = setupSessions();
  const controller = test.hook.result.current;
  test.hook.rerender({});
  expect(test.hook.result.current).toBe(controller);
  test.start();
  expect(test.hook.result.current).not.toBe(controller);
  expect(test.hook.result.current.draggingSessionId).toBe('session:b');
});
