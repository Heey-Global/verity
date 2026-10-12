import type { ReactNode } from 'react';
jest.mock('../lib/remoteControlCiExport', () => ({
  shareRemoteControlCiInputs: jest.fn().mockResolvedValue(undefined),
}));
import { shareRemoteControlCiInputs } from '../lib/remoteControlCiExport';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('../lib/updateDiagnostics', () => ({
  shareUpdateDiagnostics: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../components/settings/PublicPreviewDiagnostics', () => ({
  // The diagnostics container owns disclosure; route content is passed as children.
  PublicPreviewDiagnostics: ({ children }: { children: ReactNode }) => children,
}));
import DiagnosticsScreen from '../app/settings/diagnostics';
import { shareUpdateDiagnostics } from '../lib/updateDiagnostics';
import { gestureDiagnosticsEnabled, setGestureDiagnosticsEnabled } from '../lib/gestureDiagnostics';
import {
  makeClient,
  makeSettings,
  mockCreateVerityClient,
  mockPush,
  resetSettingsHarness,
} from './support/settingsHarness';
afterEach(() => {
  setGestureDiagnosticsEnabled(false);
  resetSettingsHarness();
  jest.clearAllMocks();
});
it('groups diagnostics and keeps transcription and log export actionable', async () => {
  mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
  render(<DiagnosticsScreen />);
  expect(await screen.findByText('No import errors')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Live transcription test'));
  expect(mockPush).toHaveBeenCalledWith('/settings/live-meeting-stt');
  fireEvent.press(screen.getByLabelText('Export app update logs'));
  await waitFor(() => expect(shareUpdateDiagnostics).toHaveBeenCalled());
  fireEvent.press(screen.getByLabelText('Export Remote Control test inputs'));
  await waitFor(() => expect(shareRemoteControlCiInputs).toHaveBeenCalled());
  expect(screen.getByText('More')).toBeOnTheScreen();
});
it('switches overview gesture recording on and off for this app run', async () => {
  mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
  render(<DiagnosticsScreen />);
  const toggle = await screen.findByLabelText('Record overview gestures');
  expect(gestureDiagnosticsEnabled()).toBe(false);
  fireEvent.press(toggle);
  expect(gestureDiagnosticsEnabled()).toBe(true);
  fireEvent.press(screen.getByLabelText('Record overview gestures'));
  expect(gestureDiagnosticsEnabled()).toBe(false);
});
it('reports unavailable integration diagnostics instead of claiming no errors', async () => {
  mockCreateVerityClient.mockReturnValue(
    makeClient('unlocked', { listIntegrations: jest.fn().mockRejectedValue(new Error('offline')) }),
  );
  render(<DiagnosticsScreen />);
  expect(
    await screen.findByText('Could not load import errors. Reopen Diagnostics to retry.'),
  ).toBeOnTheScreen();
  expect(screen.queryByText('No import errors')).toBeNull();
});

// The catalog is a developer reference; it must not clutter Diagnostics for
// everyone, but has to stay reachable once advanced mode is on.
it('links the design-system catalog only in advanced mode', async () => {
  mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
  const first = render(<DiagnosticsScreen />);
  expect(await screen.findByText('No import errors')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Design system')).toBeNull();
  first.unmount();
  resetSettingsHarness();
  mockCreateVerityClient.mockReturnValue(
    makeClient('unlocked', { settings: makeSettings({ advancedModeEnabled: true }) }),
  );
  render(<DiagnosticsScreen />);
  fireEvent.press(await screen.findByLabelText('Design system'));
  expect(mockPush).toHaveBeenCalledWith('/settings/design-system');
});
