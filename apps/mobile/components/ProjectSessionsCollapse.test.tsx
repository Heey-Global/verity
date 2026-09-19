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

  expect(StyleSheet.flatten(wrapper().props.style).display).toBe('flex');
  view.rerender(content(true));
  expect(StyleSheet.flatten(wrapper().props.style).display).toBe('none');
  expect(wrapper().props.pointerEvents).toBe('none');
  expect(screen.queryByLabelText('Session draft')).toBeNull();

  // A poll confirming the optimistic target rerenders with the same value.
  // It must remain settled instead of starting another transition.
  view.rerender(content(true));
  expect(StyleSheet.flatten(wrapper().props.style).display).toBe('none');

  view.rerender(content(false));
  expect(StyleSheet.flatten(wrapper().props.style).display).toBe('flex');
  expect(wrapper().props.pointerEvents).toBe('auto');
  expect(screen.getByLabelText('Session draft')).toHaveDisplayValue('unfinished');

  view.rerender(content(true));
  expect(StyleSheet.flatten(wrapper().props.style).display).toBe('none');
});
