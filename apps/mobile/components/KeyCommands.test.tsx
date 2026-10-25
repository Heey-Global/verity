import { fireEvent, render } from '@testing-library/react-native';
import { View } from 'react-native';

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: () => ({}),
  requireNativeViewManager: () => require('react-native').View,
}));

import { KeyCommands } from './KeyCommands';

it('forwards native chat and task microphone actions separately', () => {
  const onVoice = jest.fn();
  const ui = render(
    <KeyCommands onZoom={jest.fn()} onVoice={onVoice}>
      <View />
    </KeyCommands>,
  );
  const native = ui.UNSAFE_getAllByType(View)[0]!;
  fireEvent(native, 'voice', { nativeEvent: { action: 'toggle' } });
  fireEvent(native, 'voice', { nativeEvent: { action: 'task' } });
  expect(onVoice.mock.calls).toEqual([['toggle'], ['task']]);
});
