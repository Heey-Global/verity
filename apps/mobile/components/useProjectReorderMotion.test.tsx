import { act, renderHook } from '@testing-library/react-native';
import { Animated } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { useProjectReorderMotion } from './useProjectReorderMotion';

jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated/mock'),
  useReducedMotion: jest.fn(() => false),
}));

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

it('animates neighbors and clears their old slot offsets when the list adopts its final order', () => {
  const animations: {
    config: Animated.SpringAnimationConfig;
    start: jest.Mock;
    stop: jest.Mock;
  }[] = [];
  jest.spyOn(Animated, 'spring').mockImplementation((_value, config) => {
    const start = jest.fn();
    const stop = jest.fn();
    animations.push({ config, start, stop });
    return { start, stop, reset: jest.fn() };
  });
  const dragTranslation = new Animated.Value(0);
  const { result, rerender } = renderHook(
    ({ reordering, offset }: { reordering: boolean; offset: number }) =>
      useProjectReorderMotion({ reordering, offset, dragTranslation }),
    { initialProps: { reordering: false, offset: 0 } },
  );
  const value = result.current;
  const changes = jest.fn();
  const listener = value.addListener(({ value: next }) => changes(next));
  expect(animations).toHaveLength(0);
  rerender({ reordering: true, offset: -72 });
  const first = animations.at(-1)!;
  expect(first.config).toMatchObject({ toValue: -72, useNativeDriver: true });
  expect(first.start).toHaveBeenCalled();
  act(() => value.setValue(-36));
  rerender({ reordering: true, offset: -144 });
  expect(first.stop).toHaveBeenCalled();
  expect(animations.at(-1)!.config.toValue).toBe(-144);
  expect(changes).toHaveBeenLastCalledWith(-36);

  const running = animations.at(-1)!;
  changes.mockClear();
  rerender({ reordering: false, offset: -144 });
  expect(running.stop).toHaveBeenCalled();
  expect(changes).toHaveBeenLastCalledWith(0);
  expect(result.current).toBe(value);
  value.removeListener(listener);
});

it('uses the finger translation directly for the dragged project', () => {
  const spring = jest.spyOn(Animated, 'spring');
  const dragTranslation = new Animated.Value(45);
  const { result } = renderHook(() =>
    useProjectReorderMotion({ dragging: true, reordering: true, offset: 80, dragTranslation }),
  );
  expect(result.current).toBe(dragTranslation);
  expect(spring).not.toHaveBeenCalled();
});

it('moves neighbors immediately when reduced motion is enabled', () => {
  jest.mocked(useReducedMotion).mockReturnValue(true);
  const spring = jest.spyOn(Animated, 'spring');
  const dragTranslation = new Animated.Value(0);
  const { result, rerender } = renderHook(
    ({ reordering, offset }: { reordering: boolean; offset: number }) =>
      useProjectReorderMotion({ reordering, offset, dragTranslation }),
    { initialProps: { reordering: false, offset: 0 } },
  );
  const changes = jest.fn();
  const listener = result.current.addListener(({ value }) => changes(value));
  rerender({ reordering: true, offset: 90 });
  expect(changes).toHaveBeenLastCalledWith(90);
  rerender({ reordering: false, offset: 90 });
  expect(changes).toHaveBeenLastCalledWith(0);
  expect(spring).not.toHaveBeenCalled();
  result.current.removeListener(listener);
});
