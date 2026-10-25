import { type VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import { ProjectGoogleServices } from '../components/settings/ProjectGoogleServices';
import { resetSettingsHarness } from './support/settingsHarness';
afterEach(() => resetSettingsHarness());
it('only changes the chosen service access for this project', async () => {
  const enableProjectGoogleConnection = jest.fn().mockResolvedValue(undefined);
  const client = {
    getProjectGoogleConnection: jest.fn().mockResolvedValue({ connected: true, enabled: false }),
    enableProjectGoogleConnection,
    listGoogleAccounts: jest.fn().mockResolvedValue([
      {
        id: 'one',
        scopes: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].map(
          (scope) => `https://www.googleapis.com/auth/${scope}`,
        ),
      },
    ]),
  } as unknown as VerityClient;
  render(<ProjectGoogleServices client={client} projectId="project-a" />);
  fireEvent.press(await screen.findByLabelText('Gmail'));
  await waitFor(() =>
    expect(enableProjectGoogleConnection).toHaveBeenCalledWith('project-a', 'gmail', 'one'),
  );
  expect(enableProjectGoogleConnection).toHaveBeenCalledTimes(1);
});
