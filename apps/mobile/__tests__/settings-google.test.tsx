import { VerityApiError } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('../lib/googleDrive', () => ({
  runGoogleDriveAuth: jest.fn(),
  runGmailAuth: jest.fn(),
  runCalendarAuth: jest.fn(),
  runContactsAuth: jest.fn(),
  runGoogleWorkspaceAuth: jest.fn(),
}));
import GoogleSettings from '../app/settings/google';
import { runGmailAuth } from '../lib/googleDrive';
import {
  makeClient,
  mockCreateVerityClient,
  resetSettingsHarness,
} from './support/settingsHarness';
afterEach(() => {
  jest.mocked(runGmailAuth).mockReset();
  resetSettingsHarness();
  jest.restoreAllMocks();
});
function setup(scopes: string[]) {
  const client = Object.assign(makeClient('unlocked'), {
    getGoogleDriveConnection: jest.fn().mockResolvedValue({
      connected: false,
      clientId: 'google-client',
      scopes,
      accountEmail: null,
    }),
    getGoogleConnection: jest.fn().mockResolvedValue({
      connected: true,
      accountEmail: 'me@example.test',
      scopes,
      projects: [],
    }),
    connectGmail: jest.fn(),
    disconnectGoogleDrive: jest.fn().mockResolvedValue(undefined),
  });
  mockCreateVerityClient.mockReturnValue(client);
  return client;
}
it('shows a Gmail-only account and requires the complete editing scope set', async () => {
  setup(['documents', 'gmail.compose'].map((scope) => `https://www.googleapis.com/auth/${scope}`));
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  expect(screen.queryByText('Access granted')).toBeNull();
  expect(screen.getByText('Disconnect account')).toBeOnTheScreen();
});
it('does not change credentials when authorization is cancelled', async () => {
  const client = setup([]);
  jest.mocked(runGmailAuth).mockResolvedValue({ kind: 'cancelled' });
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  fireEvent.press(screen.getByText('Gmail'));
  await waitFor(() => expect(runGmailAuth).toHaveBeenCalled());
  expect(client.connectGmail).not.toHaveBeenCalled();
});
it('requires confirmation before disconnecting the account', async () => {
  const client = setup([]);
  const alert = jest.spyOn(Alert, 'alert');
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  fireEvent.press(screen.getByText('Disconnect account'));
  expect(client.disconnectGoogleDrive).not.toHaveBeenCalled();
  const buttons = alert.mock.calls.at(-1)?.[2];
  await act(async () => {
    buttons?.find((button) => button.text === 'Disconnect')?.onPress?.();
  });
  await waitFor(() => expect(client.disconnectGoogleDrive).toHaveBeenCalled());
});

it('keeps consent available when an older server lacks account metadata', async () => {
  const client = setup([]);
  client.getGoogleConnection.mockRejectedValue(new VerityApiError(404, 'Not found'));
  jest.mocked(runGmailAuth).mockResolvedValue({ kind: 'cancelled' });
  render(<GoogleSettings />);
  await screen.findByText('Update your server to see project usage.');
  fireEvent.press(screen.getByText('Gmail'));
  await waitFor(() => expect(runGmailAuth).toHaveBeenCalledWith('google-client'));
});

it('blocks disconnection until pending consent finishes', async () => {
  const client = setup([]);
  let finish!: (value: { kind: 'cancelled' }) => void;
  jest.mocked(runGmailAuth).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const alert = jest.spyOn(Alert, 'alert');
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  fireEvent.press(screen.getByText('Gmail'));
  expect(screen.getByRole('button', { name: 'Disconnect account' })).toBeDisabled();
  fireEvent.press(screen.getByText('Disconnect account'));
  expect(alert).not.toHaveBeenCalled();
  expect(client.disconnectGoogleDrive).not.toHaveBeenCalled();
  await act(async () => finish({ kind: 'cancelled' }));
  expect(screen.getByRole('button', { name: 'Disconnect account' })).toBeEnabled();
});

it('blocks consent and duplicate removal until disconnect finishes', async () => {
  const client = setup([]);
  let finish!: () => void;
  client.disconnectGoogleDrive.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const alert = jest.spyOn(Alert, 'alert');
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  fireEvent.press(screen.getByText('Disconnect account'));
  const confirm = alert.mock.calls
    .at(-1)?.[2]
    ?.find((button) => button.text === 'Disconnect')?.onPress;
  act(() => {
    confirm?.();
    confirm?.();
  });
  expect(client.disconnectGoogleDrive).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Gmail' })).toBeDisabled();
  fireEvent.press(screen.getByText('Gmail'));
  expect(runGmailAuth).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(screen.getByRole('button', { name: 'Gmail' })).toBeEnabled();
});
