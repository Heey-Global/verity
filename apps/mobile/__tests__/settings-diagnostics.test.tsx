import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('../lib/updateDiagnostics', () => ({
  shareUpdateDiagnostics: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../components/settings/PublicPreviewDiagnostics', () => ({
  PublicPreviewDiagnostics: () => null,
}));
import DiagnosticsScreen from '../app/settings/diagnostics';
import { shareUpdateDiagnostics } from '../lib/updateDiagnostics';
import {
  makeClient,
  mockCreateVerityClient,
  mockPush,
  resetSettingsHarness,
} from './support/settingsHarness';
afterEach(() => {
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
  expect(screen.getByText('Connection')).toBeOnTheScreen();
  expect(screen.getByText('Integrations')).toBeOnTheScreen();
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
