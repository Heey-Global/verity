import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('../components/premium/Confetti', () => ({ Confetti: () => null }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success' },
}));
import PremiumScreen from '../app/settings/premium';
import {
  makeClient,
  makeSettings,
  mockCreateVerityClient,
  resetSettingsHarness,
} from './support/settingsHarness';

const diagnostics = (control: 'connected' | 'rejected' = 'connected') => ({
  control,
  sharing: 'ready',
  remoteControl: 'ready',
  features: {
    sharing: { granted: true, enabled: true, effective: true },
    remoteAccess: { granted: true, enabled: true, effective: true },
  },
});
afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});
function clientWithKey(configured = false) {
  const settings = makeSettings({ uplinkSubscriptionKeyConfigured: configured });
  const update = jest.fn(async (patch) => ({
    ...settings,
    ...patch,
    uplinkSubscriptionKeyConfigured: patch.uplinkSubscriptionKey !== null,
  }));
  const client = makeClient('unlocked', { settings, updateVeritySettings: update });
  client.getUplinkDiagnostics = jest.fn().mockResolvedValue(diagnostics());
  mockCreateVerityClient.mockReturnValue(client);
  return { client, update };
}
it('explains Premium before accepting a key and celebrates only confirmed activation', async () => {
  const { update } = clientWithKey();
  render(<PremiumScreen />);
  expect(await screen.findByText('reachable anywhere.')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Uplink subscription key')).toBeNull();
  fireEvent.press(screen.getByLabelText('Enter subscription key'));
  fireEvent.changeText(screen.getByPlaceholderText('Paste your subscription key'), 'fixture-key');
  fireEvent.press(screen.getByLabelText('Activate'));
  expect(await screen.findByText('Premium is active')).toBeOnTheScreen();
  expect(update).toHaveBeenCalledWith({ uplinkSubscriptionKey: 'fixture-key' });
  fireEvent.press(screen.getByLabelText('Continue'));
  expect(screen.getByText('Subscription')).toBeOnTheScreen();
  expect(screen.getByLabelText('Online sharing')).toBeOnTheScreen();
});
it('does not celebrate a rejected key and keeps replacement available', async () => {
  const { client } = clientWithKey();
  client.getUplinkDiagnostics = jest
    .fn()
    .mockResolvedValue({ ...diagnostics('rejected'), reason: 'unknown_key' });
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText('Enter subscription key'));
  fireEvent.changeText(screen.getByPlaceholderText('Paste your subscription key'), 'bad-key');
  fireEvent.press(screen.getByLabelText('Activate'));
  expect(await screen.findByText('This subscription key was not recognized.')).toBeOnTheScreen();
  expect(screen.queryByText('Premium is active')).toBeNull();
});
it('confirms revocation before switching Online sharing off', async () => {
  const { update } = clientWithKey(true);
  const alert = jest.spyOn(Alert, 'alert');
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText('Online sharing'));
  expect(update).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith(
    'Turn off Online sharing?',
    'Active public links will be revoked.',
    expect.any(Array),
  );
  await act(async () => {
    alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Turn off')?.onPress?.();
  });
  await waitFor(() => expect(update).toHaveBeenCalledWith({ premiumSharingEnabled: false }));
});
it('hides switches for servers that predate feature preferences', async () => {
  const { client } = clientWithKey(true);
  client.getVeritySettings = jest.fn().mockResolvedValue(
    makeSettings({
      uplinkSubscriptionKeyConfigured: true,
      premiumSharingEnabled: undefined,
      premiumRemoteAccessEnabled: undefined,
    }),
  );
  render(<PremiumScreen />);
  expect(await screen.findByText('Subscription')).toBeOnTheScreen();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('allows activation after successfully loading an empty settings record', async () => {
  const { client, update } = clientWithKey();
  client.getVeritySettings = jest.fn().mockResolvedValue(null);
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText('Enter subscription key'));
  fireEvent.changeText(screen.getByPlaceholderText('Paste your subscription key'), 'first-key');
  fireEvent.press(screen.getByLabelText('Activate'));
  expect(await screen.findByText('Premium is active')).toBeOnTheScreen();
  expect(update).toHaveBeenCalledWith({ uplinkSubscriptionKey: 'first-key' });
});

it('retries failed switch writes from the error banner', async () => {
  const { client, update } = clientWithKey(true);
  update.mockRejectedValueOnce(new Error('offline'));
  const alert = jest.spyOn(Alert, 'alert');
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText('Online sharing'));
  await act(async () => {
    alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Turn off')?.onPress?.();
  });
  fireEvent.press(await screen.findByText('Retry'));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update).toHaveBeenLastCalledWith({ premiumSharingEnabled: false });
  expect(client.getVeritySettings).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByText('Retry')).toBeNull());
});
