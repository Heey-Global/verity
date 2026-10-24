import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import { ProjectGoogleServices } from '../components/settings/ProjectGoogleServices';
import { makeClient, resetSettingsHarness } from './support/settingsHarness';
afterEach(resetSettingsHarness);
it('changes the project default without revoking separate chat grants', async () => {
  const client = Object.assign(makeClient('unlocked'), {
    getProjectGoogleConnection: jest.fn().mockResolvedValue({
      connected: true,
      enabled: true,
      accountEmail: 'one@example.test',
      legacySessionCount: 2,
    }),
    listGoogleAccounts: jest.fn().mockResolvedValue([
      {
        id: 'one',
        email: 'one@example.test',
        displayName: null,
        scopes: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].map(
          (scope) => `https://www.googleapis.com/auth/${scope}`,
        ),
      },
    ]),
    enableProjectGoogleConnection: jest.fn().mockResolvedValue({ enabled: true }),
    disableProjectGoogleConnection: jest.fn(),
  });
  render(<ProjectGoogleServices client={client} projectId="p1" />);
  await screen.findAllByText('one@example.test');
  fireEvent.press(screen.getAllByText('one@example.test')[0]!);
  await waitFor(() =>
    expect(client.enableProjectGoogleConnection).toHaveBeenCalledWith('p1', 'gmail', 'one'),
  );
  expect(client.disableProjectGoogleConnection).not.toHaveBeenCalled();
  expect(screen.queryByText('Revoke all Gmail access')).toBeNull();
});
