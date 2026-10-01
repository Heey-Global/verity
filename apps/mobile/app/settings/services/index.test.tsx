import { render, screen } from '@testing-library/react-native';

jest.mock('@verity/mobile', () => ({
  secretStoreManaged: () => false,
  secretWritable: () => false,
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => ({}),
}));
jest.mock('../../../lib/client', () => ({ createVerityClient: () => ({}) }));
jest.mock('../../../lib/settingsStore', () => ({
  useLoadVeritySettings: () => jest.fn(),
  useVeritySettings: () => ({ settings: undefined, secretStatus: undefined }),
}));
jest.mock('../../../lib/useSettingsFields', () => ({
  useSettingsFields: () => ({ dirty: false, values: {}, commit: jest.fn() }),
}));
jest.mock('../../../lib/useSecretFields', () => ({
  useSecretFields: () => ({ dirty: false, values: {}, commit: jest.fn() }),
}));
jest.mock('../../../components/AgentLoginPanel', () => ({ AgentLoginPanel: () => null }));
jest.mock('../../../components/settings/SecretStoreSection', () => ({
  SecretStoreSection: () => null,
}));
jest.mock('../../../components/settings/PublicPreviewDiagnostics', () => ({
  PublicPreviewDiagnostics: () => {
    const { Text: NativeText } = require('react-native');
    return <NativeText>Remote diagnostic available</NativeText>;
  },
}));
jest.mock('../../../components/settings/SettingsChrome', () => {
  const { View: NativeView } = require('react-native');
  return {
    SettingsScaffold: ({ children }: { children: React.ReactNode }) => (
      <NativeView>{children}</NativeView>
    ),
    SettingsGroup: ({ children }: { children: React.ReactNode }) => (
      <NativeView>{children}</NativeView>
    ),
    SettingsListPanel: ({ children }: { children: React.ReactNode }) => (
      <NativeView>{children}</NativeView>
    ),
    SettingsNavRow: () => null,
    SettingsSaveState: () => null,
  };
});

import ServicesSettingsScreen from './index';

it('keeps connection diagnostics reachable when Core settings cannot load', () => {
  render(<ServicesSettingsScreen />);
  expect(screen.getByText('Remote diagnostic available')).toBeOnTheScreen();
});
