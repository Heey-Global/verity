import { VerityApiError, type VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import MatrixRoomsScreen from '../app/settings/services/matrix';
import MatrixAccountScreen from '../app/settings/services/matrix/account';
import {
  mockCreateVerityClient,
  mockPush,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

const source = {
  accountId: '@verity:example.test',
  sourceId: '!room:example.test',
  displayName: 'Project chat',
  inviter: null,
  projectId: null,
  status: 'pending' as const,
  activatedAt: null,
  lastIngestedAt: null,
  lastError: null,
};

afterEach(() => resetSettingsHarness());

it('shows the room overview and opens the Matrix account from its row', async () => {
  const connectedRoom = {
    ...source,
    sourceId: '!team:example.test',
    displayName: 'Team room',
    projectId: 'project-one',
    status: 'active' as const,
  };
  mockCreateVerityClient.mockReturnValue({
    listIntegrations: jest
      .fn()
      .mockResolvedValue({ accounts: [], sources: [source, connectedRoom] }),
  } as unknown as VerityClient);
  setSearchParams({});
  render(<MatrixRoomsScreen />);

  expect(await screen.findByText('Project chat')).toBeOnTheScreen();
  expect(screen.getByText('Invitations')).toBeOnTheScreen();
  expect(screen.getByText('Connected rooms')).toBeOnTheScreen();
  expect(screen.getByText('Team room')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Matrix password')).toBeNull();
  fireEvent.press(screen.getByLabelText('Matrix account'));
  expect(mockPush).toHaveBeenCalledWith('/settings/services/matrix/account');
});

it('configures the Matrix account on its detail screen', async () => {
  const saveMatrixConfig = jest.fn().mockResolvedValue(undefined);
  mockCreateVerityClient.mockReturnValue({
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    saveMatrixConfig,
  } as unknown as VerityClient);
  render(<MatrixAccountScreen />);

  fireEvent.changeText(
    await screen.findByLabelText('Matrix homeserver URL'),
    'https://matrix.example.test',
  );
  fireEvent.changeText(screen.getByLabelText('Matrix account ID'), '@verity:example.test');
  fireEvent.changeText(screen.getByLabelText('Matrix password'), 'private-password');
  fireEvent.press(screen.getByText('Save Matrix account'));

  await waitFor(() =>
    expect(saveMatrixConfig).toHaveBeenCalledWith({
      endpoint: 'https://matrix.example.test',
      username: '@verity:example.test',
      password: 'private-password',
    }),
  );
});

it('does not offer a save form when the server lacks Matrix settings', async () => {
  mockCreateVerityClient.mockReturnValue({
    getMatrixConfig: jest.fn().mockRejectedValue(new VerityApiError(404, 'Not found')),
    saveMatrixConfig: jest.fn(),
  } as unknown as VerityClient);
  render(<MatrixAccountScreen />);

  expect(await screen.findByText(/Update the server and retry/)).toBeOnTheScreen();
  expect(screen.queryByLabelText('Matrix password')).toBeNull();
});

it('shows the server reason when saving the Matrix account fails', async () => {
  mockCreateVerityClient.mockReturnValue({
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    saveMatrixConfig: jest
      .fn()
      .mockRejectedValue(
        new VerityApiError(
          409,
          'Changing the Matrix account requires resetting its device and room bindings',
        ),
      ),
  } as unknown as VerityClient);
  render(<MatrixAccountScreen />);

  fireEvent.changeText(
    await screen.findByLabelText('Matrix homeserver URL'),
    'https://matrix.example.test',
  );
  fireEvent.changeText(screen.getByLabelText('Matrix account ID'), '@verity:example.test');
  fireEvent.changeText(screen.getByLabelText('Matrix password'), 'private-password');
  fireEvent.press(screen.getByText('Save Matrix account'));

  expect(
    await screen.findByText(/requires resetting its device and room bindings/),
  ).toBeOnTheScreen();
  expect(screen.getByLabelText('Matrix homeserver URL').props.value).toBe(
    'https://matrix.example.test',
  );
});

it('keeps the Matrix form editable after validation fails and allows a retry', async () => {
  const saveMatrixConfig = jest
    .fn()
    .mockRejectedValueOnce(new VerityApiError(400, 'Invalid integration request'))
    .mockResolvedValueOnce(undefined);
  mockCreateVerityClient.mockReturnValue({
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    saveMatrixConfig,
  } as unknown as VerityClient);
  render(<MatrixAccountScreen />);

  fireEvent.changeText(
    await screen.findByLabelText('Matrix homeserver URL'),
    'https://wrong.example.test',
  );
  fireEvent.changeText(screen.getByLabelText('Matrix account ID'), '@verity:example.test');
  fireEvent.changeText(screen.getByLabelText('Matrix password'), 'private-password');
  fireEvent.press(screen.getByText('Save Matrix account'));
  expect(await screen.findByText('Check the Matrix URL and account ID.')).toBeOnTheScreen();

  fireEvent.changeText(
    screen.getByLabelText('Matrix homeserver URL'),
    'https://matrix.example.test',
  );
  fireEvent.press(screen.getByText('Save Matrix account'));
  await waitFor(() => expect(saveMatrixConfig).toHaveBeenCalledTimes(2));
  expect(saveMatrixConfig).toHaveBeenLastCalledWith({
    endpoint: 'https://matrix.example.test',
    username: '@verity:example.test',
    password: 'private-password',
  });
});

it('assigns an invited room from a project without showing server credentials', async () => {
  const bindIntegrationSource = jest
    .fn()
    .mockResolvedValue({ ...source, projectId: 'project-one', status: 'active' });
  mockCreateVerityClient.mockReturnValue({
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [source] }),
    bindIntegrationSource,
  } as unknown as VerityClient);
  setSearchParams({ projectId: 'project-one' });
  render(<MatrixRoomsScreen />);

  fireEvent.press(await screen.findByText('Project chat'));
  await waitFor(() =>
    expect(bindIntegrationSource).toHaveBeenCalledWith(
      source.accountId,
      source.sourceId,
      'project-one',
    ),
  );
  expect(screen.queryByLabelText('Matrix password')).toBeNull();
});
