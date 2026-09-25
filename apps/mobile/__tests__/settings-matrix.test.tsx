import { VerityApiError, type VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

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
    listProjects: jest
      .fn()
      .mockResolvedValue([{ id: 'project-one', owner: 'team', repo: 'first', archived: true }]),
  } as unknown as VerityClient);
  setSearchParams({});
  render(<MatrixRoomsScreen />);

  expect(await screen.findByText('Project chat')).toBeOnTheScreen();
  expect(screen.getByText('Invitations')).toBeOnTheScreen();
  expect(screen.getByText('Connected rooms')).toBeOnTheScreen();
  expect(screen.getByText('Team room')).toBeOnTheScreen();
  expect(await screen.findByText('team/first · active')).toBeOnTheScreen();
  expect(screen.queryByText('project-one')).toBeNull();
  expect(screen.queryByLabelText('Matrix password')).toBeNull();
  fireEvent.press(screen.getByLabelText('Matrix account'));
  expect(mockPush).toHaveBeenCalledWith('/settings/services/matrix/account');
});

it('assigns an invited room to a chosen project from the Matrix overview', async () => {
  let finishBinding!: (result: unknown) => void;
  const bindIntegrationSource = jest.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finishBinding = resolve;
      }),
  );
  mockCreateVerityClient.mockReturnValue({
    listIntegrations: jest
      .fn()
      .mockResolvedValueOnce({ accounts: [], sources: [source] })
      .mockResolvedValue({
        accounts: [],
        sources: [{ ...source, projectId: 'project-two', status: 'active' }],
      }),
    listProjects: jest.fn().mockResolvedValue([
      { id: 'project-one', owner: 'team', repo: 'first' },
      { id: 'project-two', owner: 'team', repo: 'second' },
      { id: 'project-old', owner: 'team', repo: 'archived', archived: true },
    ]),
    bindIntegrationSource,
  } as unknown as VerityClient);
  setSearchParams({});
  render(<MatrixRoomsScreen />);

  fireEvent.press(await screen.findByText('Project chat'));
  expect(await screen.findByText('team/second')).toBeOnTheScreen();
  expect(screen.queryByText('team/archived')).toBeNull();
  expect(bindIntegrationSource).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('team/second'));
  expect(screen.getByText('Connecting to team/second…')).toBeOnTheScreen();
  expect(screen.queryByText('team/first')).toBeNull();
  finishBinding({ ...source, projectId: 'project-two' });
  await waitFor(() =>
    expect(bindIntegrationSource).toHaveBeenCalledWith(
      source.accountId,
      source.sourceId,
      'project-two',
    ),
  );
  expect(await screen.findByText('team/second · active')).toBeOnTheScreen();
});

it('disconnects a connected room from its overview row after confirmation', async () => {
  const disconnectIntegrationSource = jest.fn().mockResolvedValue(undefined);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  mockCreateVerityClient.mockReturnValue({
    listIntegrations: jest.fn().mockResolvedValue({
      accounts: [],
      sources: [{ ...source, projectId: 'project-one', status: 'active' }],
    }),
    listProjects: jest
      .fn()
      .mockResolvedValue([{ id: 'project-one', owner: 'team', repo: 'first' }]),
    disconnectIntegrationSource,
  } as unknown as VerityClient);
  render(<MatrixRoomsScreen />);

  fireEvent.press(await screen.findByLabelText('Disconnect Project chat'));
  expect(disconnectIntegrationSource).not.toHaveBeenCalled();
  const actions = alert.mock.calls[0]?.[2];
  await act(async () => {
    actions?.find((action) => action.text === 'Disconnect')?.onPress?.();
  });
  await waitFor(() =>
    expect(disconnectIntegrationSource).toHaveBeenCalledWith(source.accountId, source.sourceId),
  );
  alert.mockRestore();
});

it('keeps pause and resume available on the connected room row', async () => {
  const pauseIntegrationSource = jest.fn().mockResolvedValue(undefined);
  mockCreateVerityClient.mockReturnValue({
    listIntegrations: jest.fn().mockResolvedValue({
      accounts: [],
      sources: [{ ...source, projectId: 'project-one', status: 'paused' }],
    }),
    listProjects: jest
      .fn()
      .mockResolvedValue([{ id: 'project-one', owner: 'team', repo: 'first' }]),
    pauseIntegrationSource,
  } as unknown as VerityClient);
  render(<MatrixRoomsScreen />);

  fireEvent.press(await screen.findByLabelText('Resume Project chat'));
  await waitFor(() =>
    expect(pauseIntegrationSource).toHaveBeenCalledWith(source.accountId, source.sourceId, false),
  );
});

it('configures the Matrix account on its detail screen', async () => {
  const saveMatrixConfig = jest.fn().mockResolvedValue(undefined);
  mockCreateVerityClient.mockReturnValue({
    getMatrixConfig: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({
      endpoint: 'https://matrix.example.test',
      username: '@verity:example.test',
      passwordConfigured: true,
    }),
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
  expect(await screen.findByText(/^Saved at /)).toBeOnTheScreen();
  expect(screen.getByText('https://matrix.example.test')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Matrix homeserver URL')).toBeNull();
  expect(screen.getByLabelText('Matrix password').props.value).toBe('');
  expect(screen.getByRole('button', { name: 'Update password' })).toBeDisabled();
});

// The save button was the one signal of whether a save could happen, and it
// looked the same disabled as enabled. Its disabled state has to be visible
// and announced, and it may only light up once every required field is filled.
it('keeps the save button disabled until the account is complete', async () => {
  mockCreateVerityClient.mockReturnValue({
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    saveMatrixConfig: jest.fn(),
  } as unknown as VerityClient);
  render(<MatrixAccountScreen />);

  const button = await screen.findByRole('button', { name: 'Save Matrix account' });
  expect(button).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Matrix homeserver URL'), 'https://m.example.test');
  fireEvent.changeText(screen.getByLabelText('Matrix account ID'), '@verity:example.test');
  expect(button).toBeDisabled();
  expect(screen.getByText('Unsaved changes')).toBeOnTheScreen();
  fireEvent.changeText(screen.getByLabelText('Matrix password'), 'private-password');
  expect(button).toBeEnabled();
});

// Once saved, the server refuses a different homeserver or account ID (the
// worker's device store is bound to that identity), so the form must not offer
// to edit them. Only a password replacement is left, and a completed save has
// to be visible: the box empties, the button dims again, and the status says so.
it('shows the saved identity read-only and only replaces the password', async () => {
  const saveMatrixConfig = jest.fn().mockResolvedValue(undefined);
  mockCreateVerityClient.mockReturnValue({
    getMatrixConfig: jest.fn().mockResolvedValue({
      endpoint: 'https://matrix.example.test',
      username: '@verity:example.test',
      passwordConfigured: true,
    }),
    saveMatrixConfig,
  } as unknown as VerityClient);
  render(<MatrixAccountScreen />);

  expect(await screen.findByText('https://matrix.example.test')).toBeOnTheScreen();
  expect(screen.getByText('@verity:example.test')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Matrix homeserver URL')).toBeNull();
  expect(screen.queryByLabelText('Matrix account ID')).toBeNull();
  expect(screen.getByText('All changes saved')).toBeOnTheScreen();
  const button = screen.getByRole('button', { name: 'Update password' });
  expect(button).toBeDisabled();

  fireEvent.changeText(screen.getByLabelText('Matrix password'), 'new-password');
  expect(button).toBeEnabled();
  expect(screen.getByText('Unsaved changes')).toBeOnTheScreen();
  fireEvent.press(button);

  await waitFor(() =>
    expect(saveMatrixConfig).toHaveBeenCalledWith({
      endpoint: 'https://matrix.example.test',
      username: '@verity:example.test',
      password: 'new-password',
    }),
  );
  expect(await screen.findByText(/^Saved at /)).toBeOnTheScreen();
  expect(screen.getByLabelText('Matrix password').props.value).toBe('');
  expect(screen.getByRole('button', { name: 'Update password' })).toBeDisabled();
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
