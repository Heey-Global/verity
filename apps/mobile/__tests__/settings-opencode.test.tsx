import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
  it('sorts discovered models and filters without changing saved selections', async () => {
    const updateVeritySettings = jest.fn();
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        settings: makeSettings({
          opencodeModels: 'zeta/model-10\nAlpha/model-2\nzeta/model-2\nAlpha/model-2',
          opencodeDisabledModels: 'zeta/model-2',
        }),
        updateVeritySettings,
      }),
    );
    render(<OpenCodeSettingsScreen />);
    await screen.findByLabelText('Alpha/model-2');
    expect(screen.getAllByRole('switch').map((row) => row.props.accessibilityLabel)).toEqual([
      'Alpha/model-2',
      'zeta/model-10',
      'zeta/model-2',
    ]);
    expect(screen.getAllByTestId('opencode-model-separator')).toHaveLength(1);
    const search = screen.getByLabelText('Search models');
    fireEvent.changeText(search, ' ZETA/MODEL-2 ');
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(screen.getByLabelText('zeta/model-2').props.accessibilityState.checked).toBe(false);
    expect(screen.queryByTestId('opencode-model-separator')).toBeNull();
    expect(screen.getByText('2 of 3 enabled')).toBeOnTheScreen();
    fireEvent.changeText(search, 'unavailable');
    expect(screen.getByText('No models match your search.')).toBeOnTheScreen();
    fireEvent.changeText(search, '');
    expect(screen.getAllByRole('switch')).toHaveLength(3);
    expect(updateVeritySettings).not.toHaveBeenCalled();
  });

  it('keeps the opening order through toggles and reorders on reopening', async () => {
    let current = makeSettings({
      opencodeModels: 'z/three\na/one\nb/two',
      opencodeDisabledModels: 'a/one',
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getVeritySettings: jest.fn(async () => current),
        updateVeritySettings: jest.fn(async (patch) => {
          current = { ...current, ...patch };
          return current;
        }),
      }),
    );
    const labels = () => screen.getAllByRole('switch').map((row) => row.props.accessibilityLabel);
    const view = render(<OpenCodeSettingsScreen />);
    await screen.findByLabelText('a/one');
    expect(labels()).toEqual(['b/two', 'z/three', 'a/one']);
    expect(screen.getAllByTestId('opencode-model-separator')).toHaveLength(1);
    fireEvent.press(screen.getByLabelText('a/one'));
    await waitFor(() =>
      expect(screen.getByLabelText('a/one').props.accessibilityState.checked).toBe(true),
    );
    expect(labels()).toEqual(['b/two', 'z/three', 'a/one']);
    expect(screen.getAllByTestId('opencode-model-separator')).toHaveLength(1);
    view.unmount();
    render(<OpenCodeSettingsScreen />);
    await screen.findByLabelText('a/one');
    await waitFor(() => expect(labels()).toEqual(['a/one', 'b/two', 'z/three']));
    expect(screen.queryByTestId('opencode-model-separator')).toBeNull();
  });

  it('omits the divider when every model starts disabled', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        settings: makeSettings({
          opencodeModels: 'b/two\na/one',
          opencodeDisabledModels: 'a/one\nb/two',
        }),
      }),
    );
    render(<OpenCodeSettingsScreen />);
    await screen.findByLabelText('a/one');
    expect(screen.getAllByRole('switch').map((row) => row.props.accessibilityLabel)).toEqual([
      'a/one',
      'b/two',
    ]);
    expect(screen.queryByTestId('opencode-model-separator')).toBeNull();
  });

  it('keeps newer toggles while older saves settle and persists them across reopening', async () => {
    let current = makeSettings({ opencodeModels: 'a/one\nb/two\nc/three' });
    const complete: (() => void)[] = [];
    const updateVeritySettings = jest.fn().mockImplementation(
      (patch) =>
        new Promise((resolve) => {
          complete.push(() => {
            current = { ...current, ...patch };
            resolve(current);
          });
        }),
    );
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getVeritySettings: jest.fn(async () => current),
        updateVeritySettings,
      }),
    );
    const view = render(<OpenCodeSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('a/one'));
    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByLabelText('b/two'));
    await act(async () => complete.shift()!());
    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(2));
    // The first response cannot erase B before the next edit is calculated.
    expect(screen.getByLabelText('b/two').props.accessibilityState.checked).toBe(false);
    fireEvent.press(screen.getByLabelText('c/three'));
    await act(async () => complete.shift()!());
    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(3));
    await act(async () => complete.shift()!());
    expect(current.opencodeDisabledModels).toBe('a/one\nb/two\nc/three');
    view.unmount();
    render(<OpenCodeSettingsScreen />);
    await screen.findByLabelText('c/three');
    await waitFor(() => expect(screen.getByText('0 of 3 enabled')).toBeOnTheScreen());
  });

  it.each([1, 2])('reconciles queued edits when save %s fails', async (failedSave) => {
    let current = makeSettings({ opencodeModels: 'provider/one\nprovider/two' });
    const complete: (() => void)[] = [];
    let attempts = 0;
    const updateVeritySettings = jest.fn().mockImplementation((patch) => {
      const attempt = ++attempts;
      return new Promise((resolve, reject) => {
        complete.push(() => {
          if (attempt === failedSave) reject(new Error('offline'));
          else {
            current = { ...current, ...patch };
            resolve(current);
          }
        });
      });
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getVeritySettings: jest.fn(async () => current),
        updateVeritySettings,
      }),
    );
    render(<OpenCodeSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('provider/one'));
    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByLabelText('provider/two'));
    await act(async () => complete.shift()!());
    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('provider/two').props.accessibilityState.checked).toBe(false);
    await act(async () => complete.shift()!());
    if (failedSave === 2) {
      expect(current.opencodeDisabledModels).toBe('provider/one');
      expect(screen.getByLabelText('provider/one').props.accessibilityState.checked).toBe(false);
      expect(screen.getByLabelText('provider/two').props.accessibilityState.checked).toBe(true);
      fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(3));
      await act(async () => complete.shift()!());
    }
    expect(current.opencodeDisabledModels).toBe('provider/one\nprovider/two');
    expect(screen.queryByText('Could not save settings')).toBeNull();
    expect(screen.getByText('0 of 2 enabled')).toBeOnTheScreen();
  });

  it('restores confirmed choices after a failed save and retries the requested selection', async () => {
    let current = makeSettings({ opencodeModels: 'provider/one\nprovider/two' });
    const updateVeritySettings = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async (patch) => {
        current = { ...current, ...patch };
        return current;
      });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getVeritySettings: jest.fn(async () => current),
        updateVeritySettings,
      }),
    );
    render(<OpenCodeSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('provider/two'));
    await screen.findByText('Could not save settings');
    await waitFor(() =>
      expect(screen.getByLabelText('provider/two').props.accessibilityState.checked).toBe(true),
    );
    expect(screen.queryByText('All changes saved')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.getByLabelText('provider/two').props.accessibilityState.checked).toBe(false),
    );
    expect(current.opencodeDisabledModels).toBe('provider/two');
  });

  it('disables model writes while credentials are locked', async () => {
    const updateVeritySettings = jest.fn();
    mockCreateVerityClient.mockReturnValue(
      makeClient('sealed', {
        settings: makeSettings({ opencodeModels: 'provider/one' }),
        updateVeritySettings,
      }),
    );
    render(<OpenCodeSettingsScreen />);
    const toggle = await screen.findByLabelText('provider/one');
    expect(toggle).toBeDisabled();
    expect(screen.getByLabelText('Disable all models')).toBeDisabled();
    expect(screen.getByText('Unlock credentials to change model availability.')).toBeOnTheScreen();
    fireEvent.press(toggle);
    fireEvent.press(screen.getByLabelText('Disable all models'));
    expect(updateVeritySettings).not.toHaveBeenCalled();
  });

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
