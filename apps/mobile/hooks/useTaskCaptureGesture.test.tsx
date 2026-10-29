import { renderHook } from '@testing-library/react-native';
import { useTaskCaptureGesture } from './useTaskCaptureGesture';

function setup() {
  const capture = jest.fn();
  const openTasks = jest.fn();
  const { result, rerender } = renderHook(() => useTaskCaptureGesture(capture, openTasks));
  result.current.onPressIn();
  return { result, rerender, capture, openTasks };
}

it('records on a tap, allowing slight finger movement', () => {
  const { result, capture, openTasks } = setup();
  expect(result.current.claimDrag(3, 4)).toBe(false);
  result.current.onPress();
  expect(capture).toHaveBeenCalledTimes(1);
  expect(openTasks).not.toHaveBeenCalled();
});

it('opens tasks on a stationary hold without recording on release', () => {
  const { result, capture, openTasks } = setup();
  result.current.onLongPress();
  result.current.onPress();
  expect(openTasks).toHaveBeenCalledTimes(1);
  expect(capture).not.toHaveBeenCalled();
});

it('does not record when a quick drag ends before the long press delay', () => {
  const { result, capture, openTasks } = setup();
  result.current.claimDrag(20, 0);
  result.current.onPress();
  expect(capture).not.toHaveBeenCalled();
  expect(openTasks).not.toHaveBeenCalled();
});

it.each([
  [9, 0],
  [0, -9],
  [6, 6],
])('suppresses hold and release after dragging by %s, %s, including after rerender', (dx, dy) => {
  const { result, rerender, capture, openTasks } = setup();
  expect(result.current.claimDrag(dx, dy)).toBe(true);
  rerender({});
  // Returning to the starting point does not turn a drag back into a tap.
  result.current.claimDrag(0, 0);
  result.current.onLongPress();
  result.current.onPress();
  expect(capture).not.toHaveBeenCalled();
  expect(openTasks).not.toHaveBeenCalled();
  result.current.onPressIn();
  result.current.onPress();
  expect(capture).toHaveBeenCalledTimes(1);
});

it('allows repeated accessibility activation without press-in events', () => {
  const { result, capture, openTasks } = setup();
  result.current.onPress();
  result.current.onPress();
  expect(capture).toHaveBeenCalledTimes(2);
  expect(openTasks).not.toHaveBeenCalled();
});
