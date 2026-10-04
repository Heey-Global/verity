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

it('shows the verified Matrix rejection and clears the retry notice after recovery', async () => {
  let diagnostics = [
    {
      sourceId: 'room',
      eventId: '$failed-event',
      occurredAt: '2026-10-04T10:00:00Z',
      lastAttemptAt: '2026-10-04T10:01:00Z',
      attempts: 3,
      httpStatus: 422,
      code: 'target_message_not_found',
    },
  ];
  const listIntegrations = jest.fn().mockImplementation(async () => ({
    accounts: [{ provider: 'matrix' }],
    sources: [
      {
        ...source,
        status: 'active',
        projectId: 'project-a',
        lastError: 'unsafe secret response body',
        importDiagnostics: diagnostics,
      },
    ],
  }));
  const client = { listIntegrations } as unknown as VerityClient;
  const first = render(<ProjectMatrixRooms client={client} projectId="project-a" />);
  expect(await screen.findByText(/original message for this edit or deletion/)).toBeOnTheScreen();
  expect(screen.getByText('Event: $failed-event · HTTP 422 · Attempts: 3')).toBeOnTheScreen();
  expect(screen.queryByText(/unsafe secret/)).toBeNull();
  first.unmount();
  diagnostics = [];
  render(<ProjectMatrixRooms client={client} projectId="project-a" />);
  expect(await screen.findByText('Invited room')).toBeOnTheScreen();
  expect(screen.queryByText(/Import retrying/)).toBeNull();
});

it('shows attachment failures as pending while the Matrix room is paused', async () => {
  const client = {
    listIntegrations: jest.fn().mockResolvedValue({
      accounts: [{ provider: 'matrix' }],
      sources: [
        {
          ...source,
          status: 'paused',
          projectId: 'project-a',
          importDiagnostics: [
            {
              sourceId: 'room',
              eventId: '$attachment',
              occurredAt: '2026-10-04T10:00:00Z',
              lastAttemptAt: '2026-10-04T10:01:00Z',
              attempts: 1,
              httpStatus: null,
              code: 'media_download_failed',
            },
          ],
          importDiagnosticsTruncated: true,
        },
      ],
    }),
  } as unknown as VerityClient;
  render(<ProjectMatrixRooms client={client} projectId="project-a" />);
  expect(
    await screen.findByText(/Import pending \(room paused\).*could not be downloaded or decrypted/),
  ).toBeOnTheScreen();
  expect(screen.getByText(/Import diagnostics incomplete/)).toBeOnTheScreen();
  expect(screen.queryByText(/Import retrying/)).toBeNull();
});
