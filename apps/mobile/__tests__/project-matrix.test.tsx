import { type VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import { ProjectMatrixRooms } from '../components/settings/ProjectMatrixRooms';
import { mockPush, resetSettingsHarness } from './support/settingsHarness';

const source = {
  accountId: 'account',
  sourceId: 'room',
  displayName: 'Invited room',
  projectId: null,
  status: 'pending',
};
afterEach(() => {
  jest.restoreAllMocks();
  resetSettingsHarness();
});
it('connects an invitation to this project only after confirmation', async () => {
  const bindIntegrationSource = jest.fn().mockResolvedValue(undefined);
  const client = {
    listIntegrations: jest
      .fn()
      .mockResolvedValue({ accounts: [{ provider: 'matrix' }], sources: [source] }),
    bindIntegrationSource,
  } as unknown as VerityClient;
  const alert = jest.spyOn(Alert, 'alert');
  render(<ProjectMatrixRooms client={client} projectId="project-a" />);
  fireEvent.press(await screen.findByText('Invited room'));
  expect(bindIntegrationSource).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0]?.[2];
  buttons?.find((button) => button.text === 'Connect')?.onPress?.();
  await waitFor(() =>
    expect(bindIntegrationSource).toHaveBeenCalledWith('account', 'room', 'project-a'),
  );
});
it('keeps existing room assignment intact until a user changes it', async () => {
  const client = {
    listIntegrations: jest.fn().mockResolvedValue({
      accounts: [{ provider: 'matrix' }],
      sources: [{ ...source, status: 'paused', projectId: 'project-a' }],
    }),
    bindIntegrationSource: jest.fn(),
    disconnectIntegrationSource: jest.fn(),
  } as unknown as VerityClient;
  render(<ProjectMatrixRooms client={client} projectId="project-a" />);
  expect(await screen.findByText('Invited room')).toBeOnTheScreen();
  expect(screen.getByText('paused')).toBeOnTheScreen();
  expect(client.bindIntegrationSource).not.toHaveBeenCalled();
  expect(client.disconnectIntegrationSource).not.toHaveBeenCalled();
});

it('opens the Matrix settings directly when connecting an account', async () => {
  const client = {
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [] }),
  } as unknown as VerityClient;
  render(<ProjectMatrixRooms client={client} projectId="project-a" />);

  fireEvent.press(await screen.findByLabelText('Connect Matrix'));
  expect(mockPush).toHaveBeenCalledWith('/settings/services/matrix');
});
