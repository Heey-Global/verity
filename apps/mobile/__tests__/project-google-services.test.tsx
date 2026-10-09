import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import { ProjectGoogleServices } from '../components/settings/ProjectGoogleServices';
import { makeClient, resetSettingsHarness } from './support/settingsHarness';
afterEach(resetSettingsHarness);
it('distinguishes legacy chat access from project access and offers complete revocation', async () => {
  let legacySessionCount = 2;
  const client = Object.assign(makeClient('unlocked'), {
    getProjectGoogleConnection: jest.fn().mockImplementation(async (_projectId, service) => ({
      connected: true,
      enabled: false,
      legacySessionCount: service === 'gmail' ? legacySessionCount : 0,
    })),
    disableProjectGoogleConnection: jest.fn().mockImplementation(async () => {
      legacySessionCount = 0;
    }),
  });
  render(<ProjectGoogleServices client={client} projectId="p1" />);
  await screen.findByText('2 existing chats have separate access.');
  expect(screen.getByLabelText('Gmail').props.accessibilityState.checked).toBe(false);
  fireEvent.press(screen.getByText('Revoke all Gmail access'));
  await waitFor(() =>
    expect(client.disableProjectGoogleConnection).toHaveBeenCalledWith('p1', 'gmail'),
  );
  await waitFor(() =>
    expect(screen.queryByText('2 existing chats have separate access.')).toBeNull(),
  );
});
