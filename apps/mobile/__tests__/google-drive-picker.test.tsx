import { type VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockBack = jest.fn();
const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
const mockRunGoogleDriveAuth = jest.fn();
let mockParams = { sessionId: 'session-1', purpose: 'folder' };

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
  runGoogleWorkspaceAuth: (...args: unknown[]) => mockRunGoogleDriveAuth(...args),
  ensureGoogleWorkspaceAccess: jest.fn().mockResolvedValue(true),
}));

import GoogleDrivePickerScreen from '../app/google-drive/[sessionId]';

afterEach(() => {
  jest.restoreAllMocks();
  mockBack.mockReset();
  mockCreateVerityClient.mockReset();
  mockRunGoogleDriveAuth.mockReset();
  mockParams = { sessionId: 'session-1', purpose: 'folder' };
});

it('uses an existing Drive connection without authorizing it again', async () => {
  mockParams = { sessionId: 'project-1', purpose: 'folder' };
  const client = {
    getVeritySettings: jest.fn().mockResolvedValue({
      googleDriveClientId: '123-example.apps.googleusercontent.com',
      googleDriveConnected: true,
    }),
    listGoogleDriveFiles: jest.fn().mockResolvedValue({ files: [] }),
  } as unknown as VerityClient;
  mockCreateVerityClient.mockReturnValue(client);

  render(<GoogleDrivePickerScreen />);

  await waitFor(() => expect(screen.getByPlaceholderText('Search Google Drive')).toBeTruthy());
  expect(mockRunGoogleDriveAuth).not.toHaveBeenCalled();
});

it('opens a shared drive from the combined Shared view', async () => {
  mockParams = { sessionId: 'project-1', purpose: 'folder' };
  const listFiles = jest.fn().mockResolvedValue({ files: [] });
  const client = {
    getVeritySettings: jest.fn().mockResolvedValue({
      googleDriveClientId: '123-example.apps.googleusercontent.com',
      googleDriveConnected: true,
    }),
    listGoogleDriveFiles: listFiles,
    listGoogleSharedDrives: jest.fn().mockResolvedValue({
      drives: [{ id: 'drive-1', name: 'Finance' }],
    }),
  } as unknown as VerityClient;
  mockCreateVerityClient.mockReturnValue(client);

  render(<GoogleDrivePickerScreen />);
  fireEvent.press(await screen.findByText('Shared'));
  expect(await screen.findByText('Shared drive')).toBeTruthy();
  fireEvent.press(screen.getByText('Finance'));

  await waitFor(() =>
    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        driveId: 'drive-1',
        parentId: 'drive-1',
        purpose: 'folder',
      }),
    ),
  );
});

it('selects a folder without importing or assigning a document', async () => {
  const connectFolder = jest.fn().mockResolvedValue({});
  const listFiles = jest
    .fn()
    .mockResolvedValueOnce({
      files: [
        {
          id: 'folder-1',
          name: 'Project documents',
          mimeType: 'application/vnd.google-apps.folder',
        },
        { id: 'doc-1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
      ],
    })
    .mockResolvedValue({ files: [] });
  const assign = jest.fn();
  const importFile = jest.fn();
  mockCreateVerityClient.mockReturnValue({
    getVeritySettings: jest.fn().mockResolvedValue({ googleDriveConnected: true }),
    listGoogleDriveFiles: listFiles,
    connectProjectGoogleDriveFolder: connectFolder,
    assignSessionGoogleWorkspaceFile: assign,
    importGoogleDriveFile: importFile,
  } as unknown as VerityClient);
  render(<GoogleDrivePickerScreen />);
  fireEvent.press(await screen.findByText('Notes'));
  expect(assign).not.toHaveBeenCalled();
  expect(importFile).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Project documents'));
  fireEvent.press(await screen.findByText('Connect this folder'));
  await waitFor(() => expect(connectFolder).toHaveBeenCalledWith('session-1', 'folder-1'));
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
});
