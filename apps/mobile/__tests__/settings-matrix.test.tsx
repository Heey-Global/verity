import { VerityApiError, type VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import MatrixScreen from '../app/settings/services/matrix';
import {
  mockCreateVerityClient,
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

it('shows account setup directly and keeps rooms in project settings', async () => {
  const connectedRoom = {
    ...source,
    sourceId: '!team:example.test',
    displayName: 'Team room',
    projectId: 'project-one',
    status: 'active' as const,
  };
  mockCreateVerityClient.mockReturnValue({
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    listIntegrations: jest
      .fn()
      .mockResolvedValue({ accounts: [], sources: [source, connectedRoom] }),
    listProjects: jest
      .fn()
      .mockResolvedValue([{ id: 'project-one', owner: 'team', repo: 'first', archived: true }]),
  } as unknown as VerityClient);
  setSearchParams({});
  render(<MatrixScreen />);

  expect(await screen.findByLabelText('Matrix homeserver URL')).toBeOnTheScreen();
  expect(screen.queryByText('Connected rooms')).toBeNull();
  expect(screen.queryByText('Project chat')).toBeNull();
  expect(screen.queryByText('Team room')).toBeNull();
  expect(screen.queryByText('Manage in project')).toBeNull();
  expect(screen.getByLabelText('Matrix password')).toBeOnTheScreen();
});

it('configures the Matrix account directly on the Matrix screen', async () => {
  const saveMatrixConfig = jest.fn().mockResolvedValue(undefined);
  mockCreateVerityClient.mockReturnValue({
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [] }),
    getMatrixConfig: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({
      endpoint: 'https://matrix.example.test',
      username: '@verity:example.test',
      passwordConfigured: true,
    }),
    saveMatrixConfig,
  } as unknown as VerityClient);
  render(<MatrixScreen />);

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
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [] }),
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    saveMatrixConfig: jest.fn(),
  } as unknown as VerityClient);
  render(<MatrixScreen />);

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
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [] }),
    getMatrixConfig: jest.fn().mockResolvedValue({
      endpoint: 'https://matrix.example.test',
      username: '@verity:example.test',
      passwordConfigured: true,
    }),
    saveMatrixConfig,
  } as unknown as VerityClient);
  render(<MatrixScreen />);

  expect(await screen.findByText('https://matrix.example.test')).toBeOnTheScreen();
  expect(screen.getByText('@verity:example.test')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Matrix homeserver URL')).toBeNull();
  expect(screen.queryByLabelText('Matrix account ID')).toBeNull();
  expect(screen.queryByText('All changes saved')).toBeNull();
  expect(screen.queryByText(/^Saved at /)).toBeNull();
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
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [] }),
    getMatrixConfig: jest.fn().mockRejectedValue(new VerityApiError(404, 'Not found')),
    saveMatrixConfig: jest.fn(),
  } as unknown as VerityClient);
  render(<MatrixScreen />);

  expect(await screen.findByText(/Update the server and retry/)).toBeOnTheScreen();
  expect(screen.queryByLabelText('Matrix password')).toBeNull();
});

it('shows the server reason when saving the Matrix account fails', async () => {
  mockCreateVerityClient.mockReturnValue({
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [] }),
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
  render(<MatrixScreen />);

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
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [] }),
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    saveMatrixConfig,
  } as unknown as VerityClient);
  render(<MatrixScreen />);

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

// A bare error badge hides the connector's explanation and looks like an
// ongoing connection attempt when rendered with the transient spinner.
it('shows the connector failure reason alongside its account status', async () => {
  mockCreateVerityClient.mockReturnValue({
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    listIntegrations: jest.fn().mockResolvedValue({
      accounts: [
        {
          accountId: '@verity:example.test',
          provider: 'matrix',
          displayName: 'Matrix',
          endpoint: 'https://matrix.example.test',
          status: 'error',
          lastError: '2 message imports are retrying',
        },
      ],
      sources: [],
    }),
    listProjects: jest.fn().mockResolvedValue([]),
  } as unknown as VerityClient);
  render(<MatrixScreen />);

  expect(await screen.findByText('2 message imports are retrying')).toBeOnTheScreen();
});
