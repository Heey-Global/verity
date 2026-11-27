import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('../../__tests__/support/settingsHarness').expoRouterMock());
import { makeClient, resetSettingsHarness } from '../../__tests__/support/settingsHarness';
import { ServerMonitoring } from './ServerMonitoring';

const measuring = {
  measurementEnabled: true,
  detailMode: { active: false, until: null, startedBy: null, remainingSeconds: 0 },
};
const detailRunning = {
  measurementEnabled: true,
  detailMode: {
    active: true,
    until: '2026-11-25T15:42:00.000Z',
    startedBy: 'control',
    remainingSeconds: 42 * 60,
  },
};

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

it('stays hidden when the server offers no monitoring or the person is no administrator', async () => {
  const state = jest.fn().mockRejectedValue(new Error('403'));
  render(<ServerMonitoring client={makeClient('unlocked', { monitoring: { state } })} />);
  await waitFor(() => expect(state).toHaveBeenCalled());
  expect(screen.queryByText('Server monitoring')).toBeNull();
});

it('switches measurement off on the server', async () => {
  const setMeasurementEnabled = jest
    .fn()
    .mockResolvedValue({ ...measuring, measurementEnabled: false });
  render(
    <ServerMonitoring
      client={makeClient('unlocked', {
        monitoring: { state: jest.fn().mockResolvedValue(measuring), setMeasurementEnabled },
      })}
    />,
  );
  fireEvent(await screen.findByRole('switch'), 'valueChange', false);
  await waitFor(() => expect(setMeasurementEnabled).toHaveBeenCalledWith(false));
  expect(await screen.findByText('Needs measurement')).toBeOnTheScreen();
});

it('starts detail mode for the chosen duration only', async () => {
  const startDetailMode = jest.fn().mockResolvedValue(detailRunning);
  render(
    <ServerMonitoring
      client={makeClient('unlocked', {
        monitoring: { state: jest.fn().mockResolvedValue(measuring), startDetailMode },
      })}
    />,
  );
  fireEvent.press(await screen.findByText('Detail mode'));
  fireEvent.press(screen.getByText('15 minutes'));
  fireEvent.press(screen.getByRole('button', { name: 'Start for 15 minutes' }));
  await waitFor(() => expect(startDetailMode).toHaveBeenCalledWith(15));
  expect(await screen.findByText('On · 42 min left')).toBeOnTheScreen();
});

it('shows who started a running detail mode and stops it', async () => {
  const stopDetailMode = jest.fn().mockResolvedValue(measuring);
  render(
    <ServerMonitoring
      client={makeClient('unlocked', {
        monitoring: { state: jest.fn().mockResolvedValue(detailRunning), stopDetailMode },
      })}
    />,
  );
  fireEvent.press(await screen.findByText('Detail mode'));
  expect(screen.getByText('Verity Control')).toBeOnTheScreen();
  fireEvent.press(screen.getByRole('button', { name: 'Stop detail mode' }));
  await waitFor(() => expect(stopDetailMode).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Off')).toBeOnTheScreen();
});
