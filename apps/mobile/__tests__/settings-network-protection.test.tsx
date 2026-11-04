import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import NetworkProtectionScreen from '../app/settings/network-protection';
import { SettingsToggleRow } from '../components/settings/SettingsChrome';
import { veritySettingsSnapshot } from '../lib/settingsStore';
import {
  makeClient,
  makeSettings,
  mockCreateVerityClient,
  resetSettingsHarness,
} from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

function setup(enabled: boolean | undefined, available: boolean | undefined, reason?: string) {
  const settings = makeSettings({
    projectEgressEnabled: enabled,
    projectEgressAvailable: available,
    ...(reason ? { projectEgressStatus: { available: available === true, reason } } : {}),
  });
  const update = jest.fn().mockImplementation(async (patch) => ({ ...settings, ...patch }));
  mockCreateVerityClient.mockReturnValue(
    makeClient('unlocked', { settings, updateVeritySettings: update }),
  );
  const view = render(<NetworkProtectionScreen />);
  const toggle = () => view.UNSAFE_getByType(SettingsToggleRow);
  return { update, toggle };
}

it.each([
  [false, true, 'Off', false],
  [true, true, 'On', false],
  [false, false, 'Host service unavailable', true],
  [true, false, 'Host service unavailable', false],
  [undefined, undefined, 'Server update required', true],
] as const)(
  'shows the confirmed mode %s with availability %s',
  async (enabled, available, status, disabled) => {
    const { toggle } = setup(enabled, available);
    await screen.findByText(status);
    await waitFor(() => expect(toggle().props.disabled).toBe(disabled));
    expect(toggle().props.value).toBe(enabled === true);
  },
);

it('saves only the switch without asking to recreate containers', async () => {
  const { update, toggle } = setup(false, true);
  await screen.findByText('Off');
  fireEvent(toggle(), 'valueChange', true);
  await screen.findByText('On');
  expect(update).toHaveBeenCalledWith({ projectEgressEnabled: true });
  expect(veritySettingsSnapshot().applyPending).toBe(false);
});

it('keeps the confirmed mode after a failed save and retries it', async () => {
  const { update, toggle } = setup(false, true);
  update.mockRejectedValueOnce(new Error('Host unavailable'));
  await screen.findByText('Off');
  fireEvent(toggle(), 'valueChange', true);
  await screen.findByText('Could not save settings');
  expect(toggle().props.value).toBe(false);
  fireEvent.press(screen.getByText('Retry'));
  await screen.findByText('On');
  expect(update).toHaveBeenCalledTimes(2);
});

it('can disable protection while the host service is unavailable', async () => {
  const { update, toggle } = setup(true, false);
  await screen.findByText('Host service unavailable');
  fireEvent(toggle(), 'valueChange', false);
  await waitFor(() => expect(toggle().props.value).toBe(false));
  expect(update).toHaveBeenCalledWith({ projectEgressEnabled: false });
});

it.each([
  [
    'provisioning_pending',
    'Automatic host service provisioning is pending. Install the next compatible server update.',
  ],
  ['provisioning_in_progress', 'Automatic host service provisioning is in progress.'],
  [
    'runtime_unsupported',
    'This host does not have a validated runtime profile for network protection.',
  ],
  ['key_unreadable', 'The server cannot read the host service control key.'],
  ['socket_missing', 'The host service control socket is missing. The service may be stopped.'],
  ['authentication_failed', 'The server and host service control keys do not match.'],
  [
    'mandatory_inventory_incomplete',
    'The host has not yet verified all configured broker destinations.',
  ],
  ['timeout', 'The host service did not respond before the readiness deadline.'],
  ['protocol_mismatch', 'The server and host service versions are incompatible.'],
  ['packet_enforcement_unavailable', 'The host service is running without packet enforcement.'],
  ['future_reason', 'The host service is not installed or cannot be reached.'],
])(
  'explains unavailable protection for %s without exposing raw host errors',
  async (reason, message) => {
    const { toggle } = setup(false, false, reason);
    await screen.findByText(new RegExp(message));
    expect(toggle().props.disabled).toBe(true);
  },
);
