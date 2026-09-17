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

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

it('retains session state and animates from its current height when a fold reverses', () => {
  const animations: {
    value: Animated.Value;
    config: Animated.TimingAnimationConfig;
    start: jest.Mock;
    stop: jest.Mock;
  }[] = [];
  jest.spyOn(Animated, 'timing').mockImplementation((value, config) => {
    const start = jest.fn();
    const stop = jest.fn();
    animations.push({ value: value as Animated.Value, config, start, stop });
    return { start, stop, reset: jest.fn() };
  });
  const view = render(content(false));
  const measurement = () => view.UNSAFE_getAllByType(View).find((node) => node.props.onLayout)!;
  const wrapper = () => view.UNSAFE_getAllByType(View).find((node) => node.props.pointerEvents)!;
  expect(StyleSheet.flatten(wrapper().props.style).height).toBeUndefined();
  fireEvent.changeText(screen.getByLabelText('Session draft'), 'unfinished');
  fireEvent(measurement(), 'layout', { nativeEvent: { layout: { height: 240 } } });
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(240);

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
});

it('uses the measured height without animation when reduced motion is enabled', () => {
  jest.mocked(useReducedMotion).mockReturnValue(true);
  const timing = jest.spyOn(Animated, 'timing');
  const view = render(content(true));
  const measurement = view.UNSAFE_getAllByType(View).find((node) => node.props.onLayout)!;
  const wrapper = () => view.UNSAFE_getAllByType(View).find((node) => node.props.pointerEvents)!;
  fireEvent(measurement, 'layout', { nativeEvent: { layout: { height: 180 } } });
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(0);
  view.rerender(content(false));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(180);
  view.rerender(content(true));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(0);
  expect(timing).not.toHaveBeenCalled();
});
