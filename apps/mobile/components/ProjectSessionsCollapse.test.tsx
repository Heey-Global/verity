import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ProjectSessionsCollapse } from './ProjectSessionsCollapse';

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

it('follows every collapse value immediately while retaining session state', () => {
  const view = render(content(false));
  const wrapper = () => view.UNSAFE_getAllByType(View).find((node) => node.props.pointerEvents)!;
  fireEvent.changeText(screen.getByLabelText('Session draft'), 'unfinished');

  expect(StyleSheet.flatten(wrapper().props.style).height).toBeUndefined();
  view.rerender(content(true));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(0);
  expect(wrapper().props.pointerEvents).toBe('none');
  expect(screen.queryByLabelText('Session draft')).toBeNull();

  view.rerender(content(false));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBeUndefined();
  expect(wrapper().props.pointerEvents).toBe('auto');
  expect(screen.getByLabelText('Session draft')).toHaveDisplayValue('unfinished');

  view.rerender(content(true));
  expect(StyleSheet.flatten(wrapper().props.style).height).toBe(0);
});
