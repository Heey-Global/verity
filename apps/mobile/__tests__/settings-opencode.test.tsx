import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import OpenCodeSettingsScreen from '../app/settings/services/opencode';
import {
  makeClient,
  makeSettings,
  mockCreateVerityClient,
  resetSettingsHarness,
} from './support/settingsHarness';

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('settings/services/opencode', () => {
  it('saves the endpoint, key, and model exclusions independently', async () => {
    const initial = makeSettings({
      opencodeBaseUrl: 'https://api.test/v1',
      opencodeApiKeyConfigured: true,
      opencodeModels: 'provider/one\nprovider/two',
      opencodeDisabledModels: null,
    });
    let current = initial;
    const updateVeritySettings = jest.fn().mockImplementation((patch) => {
      current = { ...current, ...patch };
      return Promise.resolve(current);
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<OpenCodeSettingsScreen />);

    fireEvent.press(await screen.findByLabelText('provider/two'));
    await waitFor(() =>
      expect(updateVeritySettings).toHaveBeenCalledWith({
        opencodeDisabledModels: 'provider/two',
      }),
    );

    const key = screen.getByPlaceholderText('Paste the provider API key…');
    fireEvent.changeText(key, 'replacement-key');
    fireEvent(key, 'blur');
    await waitFor(() =>
      expect(updateVeritySettings).toHaveBeenCalledWith({ opencodeApiKey: 'replacement-key' }),
    );
  });

  it('shows newly discovered models as enabled unless explicitly disabled', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        settings: makeSettings({
          opencodeModels: 'provider/old\nprovider/new',
          opencodeDisabledModels: 'provider/old\nprovider/removed',
        }),
      }),
    );
    render(<OpenCodeSettingsScreen />);

    expect((await screen.findByLabelText('provider/old')).props.accessibilityState).toMatchObject({
      checked: false,
    });
    expect(screen.getByLabelText('provider/new').props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(screen.getByText('1 of 2 enabled')).toBeOnTheScreen();
    expect(screen.getByLabelText('Enable all models')).toBeOnTheScreen();
  });
});
