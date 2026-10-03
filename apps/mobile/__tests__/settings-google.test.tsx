import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
  buttons?.find((button) => button.text === 'Disconnect')?.onPress?.();
  await waitFor(() => expect(client.disconnectGoogleDrive).toHaveBeenCalled());
});
