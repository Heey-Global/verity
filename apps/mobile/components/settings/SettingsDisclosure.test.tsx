import { useState } from 'react';
import { TextInput } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { SettingsDisclosure } from './SettingsDisclosure';

function Draft() {
  const [value, setValue] = useState('');
  return <TextInput accessibilityLabel="Draft" value={value} onChangeText={setValue} />;
}

it('hides controls from accessibility while retaining a mounted draft', () => {
  const commit = jest.fn();
  render(
    <SettingsDisclosure title="Details" onCollapse={commit}>
      <Draft />
    </SettingsDisclosure>,
  );
  expect(screen.getByRole('button', { name: 'Details', expanded: false })).toBeOnTheScreen();
  expect(screen.queryByLabelText('Draft')).toBeNull();
  fireEvent.press(screen.getByLabelText('Details'));
  fireEvent.changeText(screen.getByLabelText('Draft'), 'unfinished');
  fireEvent.press(screen.getByLabelText('Details'));
  expect(commit).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Draft')).toBeNull();
  fireEvent.press(screen.getByLabelText('Details'));
  expect(screen.getByLabelText('Draft')).toHaveDisplayValue('unfinished');
});

it('reveals an operation needing attention even when its row was collapsed', () => {
  const view = render(
    <SettingsDisclosure title="Details">
      <Draft />
    </SettingsDisclosure>,
  );
  expect(screen.queryByLabelText('Draft')).toBeNull();
  view.rerender(
    <SettingsDisclosure title="Details" attention>
      <Draft />
    </SettingsDisclosure>,
  );
  expect(
    screen.getByRole('button', { name: 'Details', expanded: true, disabled: true }),
  ).toBeOnTheScreen();
  expect(screen.getByLabelText('Draft')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Details'));
  expect(screen.getByLabelText('Draft')).toBeOnTheScreen();
});
