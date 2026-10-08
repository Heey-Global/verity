import { fireEvent, render } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { Platform, TextInput, View } from 'react-native';

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: () => ({}),
  requireNativeViewManager: () => require('react-native').View,
}));

import { PromptComposerInput } from '../components/PromptComposerInput';

const onSend = jest.fn();

function Composer({ submitOnReturn = true, editable = true }) {
  const [value, setValue] = useState('unfinished draft');
  return (
    <PromptComposerInput
      value={value}
      onChangeText={setValue}
      submitOnReturn={submitOnReturn}
      editable={editable}
      onSend={onSend}
    />
  );
}

beforeEach(() => {
  onSend.mockClear();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  Object.defineProperty(Platform, 'isPad', { configurable: true, value: true });
});

it('retains the native Shift+Enter newline and draft without sending', () => {
  const ui = render(<Composer />);
  const input = ui.UNSAFE_getByType(TextInput);
  // UIKit inserts a newline for Shift+Return; RN reports Enter with no modifiers.
  fireEvent(input, 'keyPress', { nativeEvent: { key: 'Enter' } });
  fireEvent.changeText(input, 'unfinished\n draft');
  expect(onSend).not.toHaveBeenCalled();
  expect(ui.UNSAFE_getByType(TextInput).props.value).toBe('unfinished\n draft');
  expect(input.props.submitBehavior).toBe('newline');
});

it('sends once through the native unmodified Return command without changing text', () => {
  const ui = render(<Composer />);
  fireEvent(ui.UNSAFE_getByType(View), 'submit');
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(ui.UNSAFE_getByType(TextInput).props.value).toBe('unfinished draft');
});

it.each([
  { submitOnReturn: false, editable: true },
  { submitOnReturn: true, editable: false },
])('keeps native submission disabled for %p', (props) => {
  const ui = render(<Composer {...props} />);
  expect(ui.UNSAFE_getByType(View).props.enabled).toBe(false);
  fireEvent(ui.UNSAFE_getByType(View), 'submit');
  expect(onSend).not.toHaveBeenCalled();
});

it('does not enable Enter-to-send on iPhone', () => {
  Object.defineProperty(Platform, 'isPad', { configurable: true, value: false });
  const ui = render(<Composer />);
  expect(ui.UNSAFE_getByType(View).props.enabled).toBe(false);
});

it('keeps the native Return command unmodified, hardware-only and scoped to the composer', () => {
  const native = readFileSync(join(__dirname, '../native/VerityComposerKeys.swift'), 'utf8');
  // A Shift command or a global responder steals newlines from other text fields.
  const commands = [...native.matchAll(/UIKeyCommand\(input: ([^\n]+)\)/g)];
  expect(commands).toHaveLength(1);
  expect(commands[0][1]).toBe('"\\r", modifierFlags: [], action: #selector(submit)');
  expect(native).toContain('command.wantsPriorityOverSystemBehavior = true');
  expect(native).toContain('command.modifierFlags.isEmpty');
  expect(native).toContain('input.isFirstResponder');
  expect(native).toContain('return find(in: self)');
  expect(native).toContain('input.markedTextRange == nil');
});
