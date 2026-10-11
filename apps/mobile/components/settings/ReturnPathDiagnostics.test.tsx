import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
jest.mock('expo-router', () => require('../../__tests__/support/settingsHarness').expoRouterMock());
import { makeClient, resetSettingsHarness } from '../../__tests__/support/settingsHarness';
import { ReturnPathDiagnostics } from './ReturnPathDiagnostics';

const inactive = {
  enabled: false,
  source: 'none' as const,
  installationFingerprint: null,
  expiresAt: null,
  currentUtc: '2026-10-11T18:00:00Z',
  remainingMs: 0,
  matchedConnectors: 0,
};
afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});
it('requires confirmation and sends only the agreed expiry, then shows status and stops', async () => {
  const active = {
    ...inactive,
    enabled: true,
    source: 'runtime' as const,
    expiresAt: '2026-10-11T18:09:00.000Z',
    remainingMs: 540_000,
    installationFingerprint: '0123456789abcdef',
    matchedConnectors: 2,
  };
  const start = jest.fn().mockResolvedValue(active),
    stop = jest.fn().mockResolvedValue(inactive);
  const alert = jest.spyOn(Alert, 'alert');
  const client = makeClient('unlocked', {
    getReturnPathStatus: jest.fn().mockResolvedValue(inactive),
    startReturnPathDiagnostics: start,
    stopReturnPathDiagnostics: stop,
  });
  render(<ReturnPathDiagnostics client={client} />);
  await screen.findByText('Inactive');
  fireEvent.press(screen.getByLabelText('Start connection diagnosis'));
  expect(start).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0]?.[2];
  await act(async () => {
    buttons?.find((button) => button.text === 'Start')?.onPress?.();
  });
  await waitFor(() => expect(start).toHaveBeenCalledWith(active.expiresAt));
  expect(
    await screen.findByText(/Active · 540 seconds remaining · 2 connections/),
  ).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Stop connection diagnosis'));
  await waitFor(() => expect(stop).toHaveBeenCalled());
  await screen.findByText('Inactive');
});
it('reports unavailable status rather than claiming disabled and keeps stop available', async () => {
  const stop = jest.fn().mockResolvedValue(inactive);
  const client = makeClient('unlocked', {
    getReturnPathStatus: jest.fn().mockRejectedValue(new Error('forbidden')),
    stopReturnPathDiagnostics: stop,
  });
  render(<ReturnPathDiagnostics client={client} />);
  await screen.findByText('Diagnostic status unavailable. Refresh to retry.');
  expect(screen.queryByText('Inactive')).toBeNull();
  fireEvent.press(screen.getByLabelText('Start connection diagnosis'));
  fireEvent.press(screen.getByLabelText('Stop connection diagnosis'));
  await waitFor(() => expect(stop).toHaveBeenCalled());
});

it('does not let a stale status read overwrite a confirmed stop', async () => {
  let resolveRead: ((value: typeof inactive) => void) | undefined;
  const stale = new Promise<typeof inactive>((resolve) => {
    resolveRead = resolve;
  });
  const read = jest.fn().mockResolvedValueOnce(inactive).mockReturnValueOnce(stale);
  const stop = jest.fn().mockResolvedValue(inactive);
  const client = makeClient('unlocked', {
    getReturnPathStatus: read,
    stopReturnPathDiagnostics: stop,
  });
  render(<ReturnPathDiagnostics client={client} />);
  await screen.findByText('Inactive');
  fireEvent.press(screen.getByLabelText('Refresh diagnostic status'));
  fireEvent.press(screen.getByLabelText('Stop connection diagnosis'));
  await waitFor(() => expect(stop).toHaveBeenCalled());
  await act(async () => {
    resolveRead?.({ ...inactive, enabled: true, remainingMs: 60_000 });
  });
  expect(screen.getByText('Inactive')).toBeOnTheScreen();
  expect(screen.queryByText(/Active ·/)).toBeNull();
});
