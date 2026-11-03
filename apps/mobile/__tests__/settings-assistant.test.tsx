import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
import ProjectAssistantScreen from '../app/project/[id]/settings/assistant';
import AssistantScreen from '../app/settings/assistant';
import {
  mockCreateVerityClient,
  mockPush,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

const projects = [
  { id: 'p', owner: 'team', repo: 'app', kind: 'github' },
  { id: 'verity-control', owner: 'verity', repo: 'control', kind: 'control_plane' },
];

it('opens the assistant session and lists only granted projects', async () => {
  mockCreateVerityClient.mockReturnValue({
    listProjects: jest.fn().mockResolvedValue(projects),
    assistantSettings: jest.fn().mockResolvedValue({
      enabled: true,
      sessionId: 's-assistant',
      grants: [{ projectId: 'p', mode: 'delegate' }],
    }),
  } as unknown as VerityClient);
  render(<AssistantScreen />);
  await screen.findByText('team/app');
  expect(screen.getByText('Tasks and sessions')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: /Open assistant/ }));
  expect(mockPush).toHaveBeenCalledWith('/session/s-assistant');
  // Mail and calendar reuse the Google settings of the Verity Control project.
  fireEvent.press(screen.getByRole('button', { name: /Mail and calendar/ }));
  expect(mockPush).toHaveBeenCalledWith('/project/verity-control/settings/services?section=google');
});

it('turns the assistant on from the system switch', async () => {
  const assistantSettings = jest
    .fn()
    .mockResolvedValue({ enabled: false, sessionId: null, grants: [] });
  mockCreateVerityClient.mockReturnValue({
    listProjects: jest.fn().mockResolvedValue(projects),
    assistantSettings,
  } as unknown as VerityClient);
  render(<AssistantScreen />);
  await screen.findByText('No projects granted');
  expect(screen.queryByRole('button', { name: /Open assistant/ })).toBeNull();
  fireEvent.press(screen.getByRole('switch', { name: /Assistant/ }));
  await waitFor(() => expect(assistantSettings).toHaveBeenCalledWith(true));
});

it('only allows revoking access while the assistant is off', async () => {
  setSearchParams({ id: 'p' });
  const projectAssistant = jest.fn().mockResolvedValue({ assistantEnabled: false, mode: 'tasks' });
  mockCreateVerityClient.mockReturnValue({ projectAssistant } as unknown as VerityClient);
  render(<ProjectAssistantScreen />);
  await screen.findByText('Tasks only');
  expect(screen.getByRole('radio', { name: 'Tasks and sessions' })).toBeDisabled();
  expect(screen.getByRole('radio', { name: 'Tasks only' })).toBeChecked();
  fireEvent.press(screen.getByRole('radio', { name: 'Off · no access' }));
  await waitFor(() => expect(projectAssistant).toHaveBeenCalledWith('p', 'off'));
  expect(projectAssistant).not.toHaveBeenCalledWith('p', 'delegate');
});

it('grants a mode when the assistant is on', async () => {
  setSearchParams({ id: 'p' });
  const projectAssistant = jest.fn().mockResolvedValue({ assistantEnabled: true, mode: 'off' });
  mockCreateVerityClient.mockReturnValue({ projectAssistant } as unknown as VerityClient);
  render(<ProjectAssistantScreen />);
  await screen.findByText('Tasks and sessions');
  fireEvent.press(screen.getByRole('radio', { name: 'Tasks and sessions' }));
  await waitFor(() => expect(projectAssistant).toHaveBeenCalledWith('p', 'delegate'));
});
