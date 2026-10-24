import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('../lib/googleDrive', () => ({ runGoogleAccountAuth: jest.fn() }));
import GoogleSettings from '../app/settings/google';
import { runGoogleAccountAuth } from '../lib/googleDrive';
import { GOOGLE_SERVICES } from '../lib/googleServices';
import {
  makeClient,
  mockCreateVerityClient,
  resetSettingsHarness,
} from './support/settingsHarness';
afterEach(() => {
  jest.mocked(runGoogleAccountAuth).mockReset();
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
    connectGoogleAccount: jest.fn().mockResolvedValue({ accountId: 'one', scopes }),
    removeGoogleAccount: jest.fn().mockResolvedValue(undefined),
  });
  mockCreateVerityClient.mockReturnValue(client);
  return client;
}
const allScopes = GOOGLE_SERVICES.flatMap((service) => service.scopes);
const success = {
  kind: 'success',
  code: 'code',
  codeVerifier: 'verifier',
  redirectUri: 'app:/oauth',
} as const;
async function openAccount() {
  render(<GoogleSettings />);
  fireEvent.press(await screen.findByText('me@example.test'));
  await screen.findByText('Disconnect account');
}

it('summarises a fully granted account in one row', async () => {
  setup(allScopes);
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  expect(screen.getByText('Full access')).toBeOnTheScreen();
  expect(screen.queryByText(/Missing:/)).toBeNull();
  expect(screen.queryByText('Disconnect account')).toBeNull();
});

// A service missing only one scope cannot be used; showing it as granted would hide that.
it('lists services whose consent is incomplete', async () => {
  setup(allScopes.filter((scope) => !scope.endsWith('/calendar.events')));
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  expect(screen.getByText('Missing: Calendar')).toBeOnTheScreen();
  expect(screen.getByText('Incomplete')).toBeOnTheScreen();
});

it('adds an account with one consent and no service picker', async () => {
  const client = setup(allScopes);
  jest.mocked(runGoogleAccountAuth).mockResolvedValue({ ...success, code: 'new-code' });
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  fireEvent.press(screen.getByText('Add Google account'));
  await waitFor(() =>
    expect(client.connectGoogleAccount).toHaveBeenCalledWith({
      code: 'new-code',
      codeVerifier: 'verifier',
      redirectUri: 'app:/oauth',
    }),
  );
  expect(runGoogleAccountAuth).toHaveBeenCalledWith('google-client');
});

it('does not change credentials when authorization is cancelled', async () => {
  const client = setup([]);
  jest.mocked(runGoogleAccountAuth).mockResolvedValue({ kind: 'cancelled' });
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  fireEvent.press(screen.getByText('Add Google account'));
  await waitFor(() => expect(runGoogleAccountAuth).toHaveBeenCalled());
  expect(client.connectGoogleAccount).not.toHaveBeenCalled();
});

it('requires confirmation before disconnecting the account', async () => {
  const client = setup([]);
  await openAccount();
  fireEvent.press(screen.getByText('Disconnect account'));
  expect(client.removeGoogleAccount).not.toHaveBeenCalled();
  expect(screen.getByText('Disconnect Google account?')).toBeOnTheScreen();
  fireEvent.press(screen.getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(client.removeGoogleAccount).toHaveBeenCalled());
});

// Without the account id the server could attach new grants to whichever account signed in.
it('keeps missing-permission consent bound to the chosen account', async () => {
  const client = setup([]);
  jest.mocked(runGoogleAccountAuth).mockResolvedValue(success);
  await openAccount();
  fireEvent.press(screen.getByText('Grant missing permissions'));
  await waitFor(() =>
    expect(client.connectGoogleAccount).toHaveBeenCalledWith({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'app:/oauth',
      accountId: 'one',
    }),
  );
});

it('blocks adding and opening accounts until pending consent finishes', async () => {
  const client = setup([]);
  let finish!: (value: { kind: 'cancelled' }) => void;
  jest.mocked(runGoogleAccountAuth).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<GoogleSettings />);
  await screen.findByText('me@example.test');
  fireEvent.press(screen.getByText('Add Google account'));
  expect(screen.getByRole('button', { name: /me@example.test/ })).toBeDisabled();
  fireEvent.press(screen.getByText('Add Google account'));
  expect(runGoogleAccountAuth).toHaveBeenCalledTimes(1);
  await act(async () => finish({ kind: 'cancelled' }));
  expect(screen.getByRole('button', { name: /me@example.test/ })).toBeEnabled();
  expect(client.connectGoogleAccount).not.toHaveBeenCalled();
});

it('blocks consent and duplicate removal until disconnect finishes', async () => {
  const client = setup([]);
  let finish!: () => void;
  client.removeGoogleAccount.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await openAccount();
  fireEvent.press(screen.getByText('Disconnect account'));
  // The confirm button's own handler, twice before the next render.
  const confirm = screen.UNSAFE_getByProps({ label: 'Disconnect' }).props.onPress as () => void;
  act(() => {
    confirm();
    confirm();
  });
  expect(client.removeGoogleAccount).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Add Google account' })).toBeDisabled();
  fireEvent.press(screen.getByText('Add Google account'));
  expect(runGoogleAccountAuth).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(screen.getByRole('button', { name: 'Add Google account' })).toBeEnabled();
});
