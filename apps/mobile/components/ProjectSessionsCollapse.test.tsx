import { useState } from 'react';
import { Animated, StyleSheet, TextInput, View } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { ProjectSessionsCollapse } from './ProjectSessionsCollapse';

jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated/mock'),
  useReducedMotion: jest.fn(() => false),
}));

function Draft() {
  const [value, setValue] = useState('');
  return <TextInput accessibilityLabel="Session draft" value={value} onChangeText={setValue} />;
}

function content(collapsed: boolean) {
  return (
    <ProjectSessionsCollapse collapsed={collapsed}>
      <Draft />
    </ProjectSessionsCollapse>
  );
}

type FakeAnimation = {
  value: Animated.Value;
  config: Animated.TimingAnimationConfig;
  start: jest.Mock<void, [((result: { finished: boolean }) => void)?]>;
  stop: jest.Mock;
};

function captureAnimations(): FakeAnimation[] {
  const animations: FakeAnimation[] = [];
  jest.spyOn(Animated, 'timing').mockImplementation((value, config) => {
    const start = jest.fn();
    const stop = jest.fn();
    animations.push({ value: value as Animated.Value, config, start, stop });
    return { start, stop, reset: jest.fn() } as unknown as Animated.CompositeAnimation;
  });
  return animations;
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

it('retains session state and animates from its current height when a fold reverses', () => {
  const animations = captureAnimations();
  const view = render(content(false));
  const measurement = () => view.UNSAFE_getAllByType(View).find((node) => node.props.onLayout)!;
  const wrapper = () => view.UNSAFE_getAllByType(View).find((node) => node.props.pointerEvents)!;
  expect(StyleSheet.flatten(wrapper().props.style).height).toBeUndefined();
  fireEvent.changeText(screen.getByLabelText('Session draft'), 'unfinished');
  fireEvent(measurement(), 'layout', { nativeEvent: { layout: { height: 240 } } });
  // An open group stays at auto height: the measurement feeds the fold
  // animation, it never becomes the height the sessions are pinned to.
  expect(StyleSheet.flatten(wrapper().props.style).height).toBeUndefined();

  view.rerender(content(true));
  expect(screen.queryByLabelText('Session draft')).toBeNull();
  expect(wrapper().props.pointerEvents).toBe('none');
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(240);
  const closing = animations.at(-1)!;
  expect(closing.start).toHaveBeenCalled();
  expect(closing.config).toMatchObject({ toValue: 0, duration: 180, useNativeDriver: false });
  // Drive an intermediate native-animation frame: reversing must not jump to
  // either endpoint or recreate the session subtree.
  act(() => closing.value.setValue(120));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(120);
  view.rerender(content(false));
  expect(closing.stop).toHaveBeenCalled();
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(120);
  expect(animations.at(-1)!.config.toValue).toBe(240);
  expect(screen.getByLabelText('Session draft')).toHaveDisplayValue('unfinished');

  // Settling the unfold releases the height again, so the next measurement is
  // taken against the content rather than against the previous open height.
  act(() => animations.at(-1)!.start.mock.calls.at(-1)?.[0]?.({ finished: true }));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBeUndefined();
});

it('opens even when the unfold animation never reports success', () => {
  const animations = captureAnimations();
  const view = render(content(false));
  const measurement = view.UNSAFE_getAllByType(View).find((node) => node.props.onLayout)!;
  const wrapper = () => view.UNSAFE_getAllByType(View).find((node) => node.props.pointerEvents)!;
  fireEvent(measurement, 'layout', { nativeEvent: { layout: { height: 240 } } });
  // A drag collapses every group; the drop hands them all back to open.
  view.rerender(content(true));
  act(() => animations.at(-1)!.start.mock.calls.at(-1)?.[0]?.({ finished: true }));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(0);
  view.rerender(content(false));
  // An interrupted unfold (a detached or stopped value reports finished:false)
  // must still leave the sessions reachable instead of stranding the group at
  // the height the fold stopped at — the silent failure is a project whose
  // rows can never be seen again.
  act(() => animations.at(-1)!.start.mock.calls.at(-1)?.[0]?.({ finished: false }));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBeUndefined();
  expect(wrapper().props.pointerEvents).toBe('auto');
  expect(screen.getByLabelText('Session draft')).toBeTruthy();
});

it('ignores a stopped unfold callback after a newer fold starts', () => {
  const animations = captureAnimations();
  const view = render(content(false));
  const measurement = view.UNSAFE_getAllByType(View).find((node) => node.props.onLayout)!;
  const wrapper = () => view.UNSAFE_getAllByType(View).find((node) => node.props.pointerEvents)!;
  fireEvent(measurement, 'layout', { nativeEvent: { layout: { height: 240 } } });

  view.rerender(content(true));
  act(() => animations.at(-1)!.start.mock.calls.at(-1)?.[0]?.({ finished: true }));
  view.rerender(content(false));
  const stoppedUnfold = animations.at(-1)!;
  act(() => stoppedUnfold.value.setValue(80));
  view.rerender(content(true));
  const latestFold = animations.at(-1)!;

  // Native Animated can report the stopped transition after its replacement
  // has started. That stale callback used to put the content back at auto height.
  act(() => stoppedUnfold.start.mock.calls.at(-1)?.[0]?.({ finished: false }));
  expect(wrapper().props.pointerEvents).toBe('none');
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(80);

  act(() => latestFold.start.mock.calls.at(-1)?.[0]?.({ finished: true }));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(0);
});

it('ignores a stopped fold callback after a newer unfold starts', () => {
  const animations = captureAnimations();
  const view = render(content(false));
  const measurement = view.UNSAFE_getAllByType(View).find((node) => node.props.onLayout)!;
  const wrapper = () => view.UNSAFE_getAllByType(View).find((node) => node.props.pointerEvents)!;
  fireEvent(measurement, 'layout', { nativeEvent: { layout: { height: 240 } } });

  view.rerender(content(true));
  const stoppedFold = animations.at(-1)!;
  act(() => stoppedFold.value.setValue(80));
  view.rerender(content(false));
  const latestUnfold = animations.at(-1)!;

  // A late close callback must not hide a group whose current state is open.
  act(() => stoppedFold.start.mock.calls.at(-1)?.[0]?.({ finished: false }));
  expect(wrapper().props.pointerEvents).toBe('auto');
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(80);

  act(() => latestUnfold.start.mock.calls.at(-1)?.[0]?.({ finished: true }));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBeUndefined();
});

it('uses auto height without animation when reduced motion is enabled', () => {
  jest.mocked(useReducedMotion).mockReturnValue(true);
  const timing = jest.spyOn(Animated, 'timing');
  const view = render(content(true));
  const measurement = view.UNSAFE_getAllByType(View).find((node) => node.props.onLayout)!;
  const wrapper = () => view.UNSAFE_getAllByType(View).find((node) => node.props.pointerEvents)!;
  fireEvent(measurement, 'layout', { nativeEvent: { layout: { height: 180 } } });
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(0);
  view.rerender(content(false));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBeUndefined();
  view.rerender(content(true));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(0);
  expect(timing).not.toHaveBeenCalled();
});
