import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ProjectQAState, ProjectQASummary, VerityClient } from '@verity/mobile';
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

const summary = (patch: Partial<ProjectQASummary> = {}): ProjectQASummary => ({
  mode: 'automatic',
  health: 'healthy',
  checkedAt: new Date().toISOString(),
  open: 1,
  repairing: 0,
  needsYou: 1,
  failingPullRequests: 1,
  failingWorkflows: 0,
  stopped: [],
  ...patch,
});
const state = (patch: Partial<ProjectQAState> = {}): ProjectQAState => ({
  enabled: true,
  coding: true,
  mode: 'automatic',
  sessionId: 'qa',
  brakeAt: null,
  checkedAt: null,
  sources: { pullRequests: { readable: true, failing: 0 }, ci: { readable: true, failing: 0 } },
  issues: [],
  repairSessions: [],
  ...patch,
});

it('switches QA on for every coding project and lists each project with its state', async () => {
  const settings = jest
    .fn()
    .mockResolvedValue({ enabled: false, health: 'disabled', brakeAt: null });
  mockCreateVerityClient.mockReturnValue({
    listProjects: jest.fn().mockResolvedValue([
      {
        id: 'p',
        name: 'Team App',
        owner: 'team',
        repo: 'app',
        kind: 'github',
        qaSummary: summary(),
      },
      { id: 'n', name: 'Notes', owner: 'local', repo: 'notes', kind: 'local' },
    ]),
    projectQA: { settings },
  } as unknown as VerityClient);
  render(<RepairsScreen />);
  const toggle = await screen.findByRole('switch', { name: 'QA in coding projects' });
  await act(async () => {
    fireEvent(toggle, 'valueChange', true);
  });
  await waitFor(() => expect(settings).toHaveBeenCalledWith(true));
  settings.mockResolvedValue({ enabled: true, health: 'pending', brakeAt: null });
  expect(screen.queryByText('Notes')).toBeNull();
});

it('lists projects once QA is on and opens a project QA', async () => {
  mockCreateVerityClient.mockReturnValue({
    listProjects: jest
      .fn()
      .mockResolvedValue([
        {
          id: 'p',
          name: 'Team App',
          owner: 'team',
          repo: 'app',
          kind: 'github',
          qaSummary: summary(),
        },
      ]),
    projectQA: {
      settings: jest.fn().mockResolvedValue({ enabled: true, health: 'healthy', brakeAt: null }),
    },
  } as unknown as VerityClient);
  render(<RepairsScreen />);
  fireEvent.press(await screen.findByText('Team App'));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/project/[id]/qa', params: { id: 'p' } });
  expect(screen.queryByRole('button', { name: 'Release brake' })).toBeNull();
});

it('offers to release an engaged emergency brake', async () => {
  const releaseBrake = jest.fn().mockResolvedValue(undefined);
  mockCreateVerityClient.mockReturnValue({
    listProjects: jest.fn().mockResolvedValue([]),
    projectQA: {
      settings: jest
        .fn()
        .mockResolvedValue({ enabled: true, health: 'healthy', brakeAt: new Date().toISOString() }),
      releaseBrake,
    },
  } as unknown as VerityClient);
  render(<RepairsScreen />);
  const release = await screen.findByRole('button', { name: 'Release brake' });
  await act(async () => {
    fireEvent.press(release);
  });
  expect(releaseBrake).toHaveBeenCalled();
});

it('keeps a project switch disabled while QA is off in system settings', async () => {
  setSearchParams({ id: 'p' });
  const setMode = jest.fn();
  mockCreateVerityClient.mockReturnValue({
    projectQA: {
      state: jest.fn().mockResolvedValue(state({ enabled: false, mode: null })),
      setMode,
    },
  } as unknown as VerityClient);
  render(<ProjectRepairsScreen />);
  await screen.findByText(/switched off in system settings/);
  expect(screen.getByRole('switch', { name: 'QA for this project' })).toBeDisabled();
  expect(setMode).not.toHaveBeenCalled();
});

it('changes a project’s mode and switches its QA off', async () => {
  setSearchParams({ id: 'p' });
  const setMode = jest.fn().mockResolvedValue(undefined);
  mockCreateVerityClient.mockReturnValue({
    projectQA: { state: jest.fn().mockResolvedValue(state()), setMode },
  } as unknown as VerityClient);
  render(<ProjectRepairsScreen />);
  const observe = await screen.findByRole('radio', { name: /^Observe and propose/ });
  await act(async () => {
    fireEvent.press(observe);
  });
  expect(setMode).toHaveBeenCalledWith('p', 'monitor');
  await act(async () => {
    fireEvent(screen.getByRole('switch', { name: 'QA for this project' }), 'valueChange', false);
  });
  expect(setMode).toHaveBeenCalledWith('p', 'off');
});
