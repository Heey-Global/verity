import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
    listGoogleAccounts: jest.fn().mockResolvedValue([
      {
        id: 'one',
        displayName: null,
        clientId: 'google-client',
        credentialVersion: 1,
        email: 'me@example.test',
        connected: true,
        accountEmail: 'me@example.test',
        scopes,
        projects: [],
      },
    ]),
    connectGmail: jest.fn(),
    removeGoogleAccount: jest.fn().mockResolvedValue(undefined),
  });
  mockCreateVerityClient.mockReturnValue(client);
  return client;
}
it('shows a Gmail-only account and requires the complete editing scope set', async () => {
  setup(['documents', 'gmail.compose'].map((scope) => `https://www.googleapis.com/auth/${scope}`));
  render(<GoogleSettings />);
  await screen.findAllByText('me@example.test');
  expect(screen.queryByText('Access granted')).toBeNull();
  expect(screen.getByRole('button', { name: 'Docs, Sheets & Slides' })).toBeDisabled();
  expect(screen.getByText('Connect Drive first')).toBeOnTheScreen();
  expect(screen.getByText('Disconnect account')).toBeOnTheScreen();
});
it('does not change credentials when authorization is cancelled', async () => {
  const client = setup([]);
  jest.mocked(runGmailAuth).mockResolvedValue({ kind: 'cancelled' });
  render(<GoogleSettings />);
  await screen.findAllByText('me@example.test');
  fireEvent.press(screen.getByText('Gmail'));
  await waitFor(() => expect(runGmailAuth).toHaveBeenCalled());
  expect(client.connectGmail).not.toHaveBeenCalled();
});
it('requires confirmation before disconnecting the account', async () => {
  const client = setup([]);
  render(<GoogleSettings />);
  await screen.findAllByText('me@example.test');
  fireEvent.press(screen.getByText('Disconnect account'));
  expect(client.removeGoogleAccount).not.toHaveBeenCalled();
  expect(screen.getByText('Disconnect Google account?')).toBeOnTheScreen();
  fireEvent.press(screen.getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(client.removeGoogleAccount).toHaveBeenCalled());
});

it('keeps reconnect consent bound to the chosen account', async () => {
  const client = setup([]);
  jest.mocked(runGmailAuth).mockResolvedValue({
    kind: 'success',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'app:/oauth',
  });
  render(<GoogleSettings />);
  await screen.findAllByText('me@example.test');
  fireEvent.press(screen.getByText('Gmail'));
  await waitFor(() =>
    expect(client.connectGmail).toHaveBeenCalledWith({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'app:/oauth',
      accountId: 'one',
    }),
  );
});

it('blocks disconnection until pending consent finishes', async () => {
  const client = setup([]);
  let finish!: (value: { kind: 'cancelled' }) => void;
  jest.mocked(runGmailAuth).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<GoogleSettings />);
  await screen.findAllByText('me@example.test');
  fireEvent.press(screen.getByText('Gmail'));
  expect(screen.getByRole('button', { name: 'Disconnect account' })).toBeDisabled();
  fireEvent.press(screen.getByText('Disconnect account'));
  expect(screen.queryByText('Disconnect Google account?')).toBeNull();
  expect(client.removeGoogleAccount).not.toHaveBeenCalled();
  await act(async () => finish({ kind: 'cancelled' }));
  expect(screen.getByRole('button', { name: 'Disconnect account' })).toBeEnabled();
});

it('blocks consent and duplicate removal until disconnect finishes', async () => {
  const client = setup([]);
  let finish!: () => void;
  client.removeGoogleAccount.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  render(<GoogleSettings />);
  await screen.findAllByText('me@example.test');
  fireEvent.press(screen.getByText('Disconnect account'));
  // The confirm button's own handler, twice before the next render.
  const confirm = screen.UNSAFE_getByProps({ label: 'Disconnect' }).props.onPress as () => void;
  act(() => {
    confirm();
    confirm();
  });
  expect(client.removeGoogleAccount).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Gmail' })).toBeDisabled();
  fireEvent.press(screen.getByText('Gmail'));
  expect(runGmailAuth).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(screen.getByRole('button', { name: 'Gmail' })).toBeEnabled();
});

it('lets a new account connect Gmail without requesting Drive access', async () => {
  const client = setup([]);
  jest.mocked(runGmailAuth).mockResolvedValue({
    kind: 'success',
    code: 'new-code',
    codeVerifier: 'verifier',
    redirectUri: 'app:/oauth',
  });
  render(<GoogleSettings />);
  await screen.findAllByText('me@example.test');
  fireEvent.press(screen.getByText('Add Google account'));
  fireEvent.press(screen.getAllByText('Gmail').at(-1)!);
  await waitFor(() =>
    expect(client.connectGmail).toHaveBeenCalledWith({
      code: 'new-code',
      codeVerifier: 'verifier',
      redirectUri: 'app:/oauth',
    }),
  );
});
