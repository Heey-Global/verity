import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
import ProjectRepairsScreen from '../app/project/[id]/settings/repairs';
import RepairsScreen from '../app/settings/repairs';
import {
  mockCreateVerityClient,
  mockPush,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';
afterEach(() => resetSettingsHarness());
it('does not enroll projects until explicitly selected', async () => {
  const projectRepairs = jest.fn().mockResolvedValue({ mandate: null, incidents: [] });
  mockCreateVerityClient.mockReturnValue({
    listProjects: jest
      .fn()
      .mockResolvedValue([{ id: 'p', owner: 'team', repo: 'app', kind: 'github' }]),
    projectRepairs,
    qaSettings: jest
      .fn()
      .mockResolvedValue({ enabled: false, health: 'disabled', session_id: null }),
  } as unknown as VerityClient);
  render(<RepairsScreen />);
  await screen.findByText('team/app');
  expect(projectRepairs).toHaveBeenCalledWith('p');
  expect(projectRepairs).not.toHaveBeenCalledWith('p', 'automatic');
  expect(screen.queryByRole('button', { name: 'Allow automatic repairs' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Project settings' }));
  expect(mockPush).toHaveBeenCalledWith('/project/p/settings/model');
});
it('pauses automatic delegation before opening a session for manual takeover', async () => {
  const projectRepairs = jest.fn().mockResolvedValue({
    mandate: { mode: 'automatic', health: 'healthy', checked_at: null },
    incidents: [
      {
        id: 'i',
        resource: 'pr:42',
        state: 'working',
        attempts: 1,
        last_session_id: 's',
        owner_session_id: 's',
        evidence: '{}',
      },
    ],
  });
  mockCreateVerityClient.mockReturnValue({
    listProjects: jest
      .fn()
      .mockResolvedValue([{ id: 'p', owner: 'team', repo: 'app', kind: 'github' }]),
    projectRepairs,
    qaSettings: jest
      .fn()
      .mockResolvedValue({ enabled: false, health: 'disabled', session_id: null }),
  } as unknown as VerityClient);
  render(<RepairsScreen />);
  const takeover = await screen.findByRole('button', { name: 'Take over' });
  await act(async () => {
    fireEvent.press(takeover);
  });
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/session/s'));
  expect(projectRepairs).toHaveBeenCalledWith('p', 'off');
  expect(screen.queryByRole('button', { name: 'Retry repair' })).toBeNull();
});

it('keeps project access off and blocks opt-in while the system switch is disabled', async () => {
  setSearchParams({ id: 'p' });
  const projectRepairs = jest
    .fn()
    .mockResolvedValue({ mandate: null, incidents: [], qaEnabled: false });
  mockCreateVerityClient.mockReturnValue({ projectRepairs } as unknown as VerityClient);
  render(<ProjectRepairsScreen />);
  await screen.findByText('off');
  expect(screen.getByRole('button', { name: 'Monitor only' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Allow automatic repairs' })).toBeDisabled();
  expect(projectRepairs).not.toHaveBeenCalledWith('p', 'automatic');
});
it('sets the project mode independently of the system switch', async () => {
  setSearchParams({ id: 'p' });
  const projectRepairs = jest
    .fn()
    .mockResolvedValue({ mandate: null, incidents: [], qaEnabled: true });
  mockCreateVerityClient.mockReturnValue({ projectRepairs } as unknown as VerityClient);
  render(<ProjectRepairsScreen />);
  await screen.findByText('off');
  fireEvent.press(screen.getByRole('button', { name: 'Monitor only' }));
  await waitFor(() => expect(projectRepairs).toHaveBeenCalledWith('p', 'monitor'));
});
