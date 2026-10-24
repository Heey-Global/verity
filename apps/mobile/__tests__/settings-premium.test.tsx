import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
  expect(screen.queryByLabelText(/^Uplink subscription key(,|$)/)).toBeNull();
  fireEvent.press(screen.getByLabelText(/^Enter subscription key(,|$)/));
  fireEvent.changeText(screen.getByPlaceholderText('Paste your subscription key'), 'fixture-key');
  fireEvent.press(screen.getByLabelText(/^Activate(,|$)/));
  expect(await screen.findByText('Premium is active')).toBeOnTheScreen();
  expect(update).toHaveBeenCalledWith({ uplinkSubscriptionKey: 'fixture-key' });
  fireEvent.press(screen.getByLabelText(/^Continue(,|$)/));
  expect(screen.getByText('Subscription')).toBeOnTheScreen();
  expect(screen.getByLabelText(/^Online sharing(,|$)/)).toBeOnTheScreen();
});
it('does not celebrate a rejected key and keeps replacement available', async () => {
  const { client } = clientWithKey();
  client.getUplinkDiagnostics = jest
    .fn()
    .mockResolvedValue({ ...diagnostics('rejected'), reason: 'unknown_key' });
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText(/^Enter subscription key(,|$)/));
  fireEvent.changeText(screen.getByPlaceholderText('Paste your subscription key'), 'bad-key');
  fireEvent.press(screen.getByLabelText(/^Activate(,|$)/));
  expect(
    await screen.findByText('This key is not known to Verity Uplink. Check it in your account.'),
  ).toBeOnTheScreen();
  // The reason is explained under the field; the key stays so it can be corrected.
  expect(screen.getByRole('alert', { name: /^Unknown\. / })).toBeOnTheScreen();
  expect(screen.getByLabelText(/^Uplink subscription key(,|$)/).props.value).toBe('bad-key');
  expect(screen.queryByText('Premium is active')).toBeNull();
});
it('confirms revocation before switching Online sharing off', async () => {
  const { update } = clientWithKey(true);
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText(/^Online sharing(,|$)/));
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByText('Turn off Online sharing?')).toBeOnTheScreen();
  expect(screen.getByText('Active public links will be revoked.')).toBeOnTheScreen();
  fireEvent.press(screen.getByRole('button', { name: 'Turn off' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ premiumSharingEnabled: false }));
});

// Dismissing the question must never be read as consent to revoke links.
it('keeps Online sharing on when the confirmation is cancelled', async () => {
  const { update } = clientWithKey(true);
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText(/^Online sharing(,|$)/));
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByText('Turn off Online sharing?')).toBeNull());
  expect(update).not.toHaveBeenCalled();
});

it('removes the subscription key only after it is confirmed', async () => {
  const { update } = clientWithKey(true);
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByRole('button', { name: 'Remove subscription key' }));
  expect(update).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Remove key' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ uplinkSubscriptionKey: null }));
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
  fireEvent.press(await screen.findByLabelText(/^Enter subscription key(,|$)/));
  fireEvent.changeText(screen.getByPlaceholderText('Paste your subscription key'), 'first-key');
  fireEvent.press(screen.getByLabelText(/^Activate(,|$)/));
  expect(await screen.findByText('Premium is active')).toBeOnTheScreen();
  expect(update).toHaveBeenCalledWith({ uplinkSubscriptionKey: 'first-key' });
});

it('retries failed switch writes from the error banner', async () => {
  const { client, update } = clientWithKey(true);
  update.mockRejectedValueOnce(new Error('offline'));
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText(/^Online sharing(,|$)/));
  fireEvent.press(screen.getByRole('button', { name: 'Turn off' }));
  fireEvent.press(await screen.findByText('Retry'));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update).toHaveBeenLastCalledWith({ premiumSharingEnabled: false });
  expect(client.getVeritySettings).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByText('Retry')).toBeNull());
});

it('shows the managed subscription as one card with tag, switches and a diagnostics entry', async () => {
  clientWithKey(true);
  render(<PremiumScreen />);
  expect(await screen.findByText('Active')).toBeOnTheScreen();
  expect(screen.getByText('Connected to Uplink')).toBeOnTheScreen();
  expect(screen.getByText('Soon')).toBeOnTheScreen();
  expect(screen.getAllByRole('switch')).toHaveLength(2);
  expect(screen.getByText('Uplink connected · all features on')).toBeOnTheScreen();
  expect(screen.queryByLabelText(/^Enter subscription key(,|$)/)).toBeNull();
});

it('accepts a verified activation that already returned to idle', async () => {
  const { client } = clientWithKey();
  client.getUplinkDiagnostics = jest.fn().mockResolvedValue({
    ...diagnostics(),
    control: 'idle',
    entitlement: 'checked',
    sharing: 'unavailable',
    remoteControl: 'unavailable',
  });
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText(/^Enter subscription key(,|$)/));
  fireEvent.changeText(screen.getByPlaceholderText('Paste your subscription key'), 'fixture-key');
  fireEvent.press(screen.getByLabelText(/^Activate(,|$)/));
  expect(await screen.findByText('Premium is active')).toBeOnTheScreen();
});

it('ignores Return on an empty key field so a stored key is never overwritten', async () => {
  const { update } = clientWithKey(true);
  render(<PremiumScreen />);
  fireEvent.press(await screen.findByLabelText(/^Replace subscription key(,|$)/));
  fireEvent(screen.getByLabelText(/^Uplink subscription key(,|$)/), 'submitEditing');
  expect(update).not.toHaveBeenCalled();
});
