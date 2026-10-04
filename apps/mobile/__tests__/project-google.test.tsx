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
  } as unknown as VerityClient;
  render(<ProjectGoogleServices client={client} projectId="project-a" />);
  fireEvent.press(await screen.findByLabelText('Gmail'));
  await waitFor(() =>
    expect(enableProjectGoogleConnection).toHaveBeenCalledWith('project-a', 'gmail'),
  );
  expect(enableProjectGoogleConnection).toHaveBeenCalledTimes(1);
});
