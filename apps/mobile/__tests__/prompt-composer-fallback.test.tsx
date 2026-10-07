import { fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { Platform, TextInput } from 'react-native';

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: () => null,
}));

import { PromptComposerInput } from '../components/PromptComposerInput';

it.each(['ios', 'android', 'web'] as const)(
  'preserves multiline editing without unsafe Return submission on %s',
  (os) => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
    const onSend = jest.fn();
    function Composer() {
      const [value, setValue] = useState('draft');
      return (
        <PromptComposerInput value={value} onChangeText={setValue} submitOnReturn onSend={onSend} />
      );
    }
    const ui = render(<Composer />);
    const input = ui.UNSAFE_getByType(TextInput);
    fireEvent(input, 'keyPress', { nativeEvent: { key: 'Enter' } });
    fireEvent.changeText(input, 'draft\n');
    expect(ui.UNSAFE_getByType(TextInput).props.value).toBe('draft\n');
    expect(onSend).not.toHaveBeenCalled();
  },
);
