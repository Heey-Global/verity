import type { VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import { ProjectGoogleDriveFolders } from '../components/settings/ProjectGoogleDriveFolders';
import { resetSettingsHarness } from './support/settingsHarness';
afterEach(resetSettingsHarness);
it('keeps each folder permission bound to its account', async () => {
  const client = {
    listProjectDriveFolders: jest.fn().mockResolvedValue([
      {
        id: 'a',
        projectId: 'p',
        accountId: 'one',
        folderId: 'folder-a',
        name: 'Work',
        accountEmail: 'one@example.test',
        accessMode: 'read-only',
      },
      {
        id: 'b',
        projectId: 'p',
        accountId: 'two',
        folderId: 'folder-b',
        name: 'Personal',
        accountEmail: 'two@example.test',
        accessMode: 'read-write',
      },
    ]),
    connectProjectGoogleDriveFolder: jest.fn(),
  } as unknown as VerityClient;
  render(<ProjectGoogleDriveFolders client={client} projectId="p" />);
  fireEvent.press(await screen.findByText('Google Drive folders'));
  fireEvent.press(await screen.findByText('Work'));
  fireEvent.press(await screen.findByLabelText('Allow changes to Google Drive files'));
  await waitFor(() =>
    expect(client.connectProjectGoogleDriveFolder).toHaveBeenCalledWith(
      'p',
      'folder-a',
      'read-write',
      'one',
    ),
  );
});
