import { VerityApiError, type VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockBack = jest.fn();
const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
const mockRunGoogleDriveAuth = jest.fn();
let mockParams = { sessionId: 'session-1', purpose: 'workspace' };

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { back: () => mockBack() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
}));
jest.mock('../lib/googleDrive', () => ({
  runGoogleDriveAuth: (...args: unknown[]) => mockRunGoogleDriveAuth(...args),
}));

import GoogleDrivePickerScreen from '../app/google-drive/[sessionId]';

afterEach(() => {
  jest.restoreAllMocks();
  mockBack.mockReset();
  mockCreateVerityClient.mockReset();
  mockRunGoogleDriveAuth.mockReset();
  mockParams = { sessionId: 'session-1', purpose: 'workspace' };
});

it('authorizes a newly connected project folder account only once', async () => {
  mockParams = { sessionId: 'project-1', purpose: 'folder' };
  const getSettings = jest
    .fn()
    .mockResolvedValueOnce({
      googleDriveClientId: '123-example.apps.googleusercontent.com',
      googleDriveConnected: false,
    })
    .mockResolvedValue({
      googleDriveClientId: '123-example.apps.googleusercontent.com',
      googleDriveConnected: true,
    });
  const client = {
    getVeritySettings: getSettings,
    connectGoogleDrive: jest.fn().mockResolvedValue(undefined),
    listGoogleDriveFiles: jest.fn().mockResolvedValue({ files: [] }),
  } as unknown as VerityClient;
  mockCreateVerityClient.mockReturnValue(client);
  mockRunGoogleDriveAuth.mockResolvedValue({
    kind: 'success',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'verity-google:/oauthredirect',
  });

  render(<GoogleDrivePickerScreen />);
  fireEvent.press(await screen.findByRole('button', { name: 'Connect Google Drive' }));

  await waitFor(() => expect(client.connectGoogleDrive).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByPlaceholderText('Search Google Drive')).toBeTruthy());
  expect(mockRunGoogleDriveAuth).toHaveBeenCalledTimes(1);
});

it('reconnects an old Drive grant and retries the Workspace assignment', async () => {
  const assign = jest
    .fn()
    .mockRejectedValueOnce(
      new VerityApiError(403, 'Reconnect Google Drive to grant Workspace editing access'),
    )
    .mockResolvedValueOnce({});
  const connect = jest.fn().mockResolvedValue(undefined);
  const client = {
    getVeritySettings: jest.fn().mockResolvedValue({
      googleDriveClientId: '123-example.apps.googleusercontent.com',
      googleDriveConnected: true,
    }),
    listGoogleDriveFiles: jest.fn().mockResolvedValue({
      files: [
        {
          id: 'slides-1',
          name: 'Customer pitch',
          mimeType: 'application/vnd.google-apps.presentation',
          canEdit: true,
        },
      ],
    }),
    assignSessionGoogleWorkspaceFile: assign,
    connectGoogleDrive: connect,
  } as unknown as VerityClient;
  mockCreateVerityClient.mockReturnValue(client);
  mockRunGoogleDriveAuth.mockResolvedValue({
    kind: 'success',
    code: 'fresh-code',
    codeVerifier: 'fresh-verifier',
    redirectUri: 'verity-google:/oauthredirect',
  });
  const alert = jest.spyOn(Alert, 'alert');

  render(<GoogleDrivePickerScreen />);
  fireEvent.press(await screen.findByText('Customer pitch'));

  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith(
      'Reconnect Google Drive',
      expect.any(String),
      expect.any(Array),
    ),
  );
  const buttons = alert.mock.calls.at(-1)?.[2];
  const reconnect = buttons?.find((button) => button.text === 'Reconnect');
  await act(async () => {
    reconnect?.onPress?.();
    await Promise.resolve();
  });

  await waitFor(() =>
    expect(connect).toHaveBeenCalledWith({
      code: 'fresh-code',
      codeVerifier: 'fresh-verifier',
      redirectUri: 'verity-google:/oauthredirect',
    }),
  );
  await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
  expect(mockBack).toHaveBeenCalledTimes(1);
});
