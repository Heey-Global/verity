import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { DemoBanner } from './DemoBanner';
import { exitDemoMode, restartDemoMode } from '../lib/demoMode';

jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }));
jest.mock('../lib/demoMode', () => ({
  exitDemoMode: jest.fn().mockResolvedValue(undefined),
  restartDemoMode: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

beforeEach(() => jest.clearAllMocks());

it('labels the simulated experience and returns home before discarding demo data', () => {
  render(<DemoBanner />);
  expect(screen.getByText(/Local sample data and simulated AI/)).toBeOnTheScreen();
  // The welcome screen only links to the demo, so this banner is the one place
  // that warns against typing real secrets into simulated flows.
  expect(screen.getByText(/Do not enter real credentials/)).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Reset demo'));
  expect(router.replace).toHaveBeenCalledWith('/');
  expect(restartDemoMode).toHaveBeenCalledTimes(1);
  expect(jest.mocked(router.replace).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(restartDemoMode).mock.invocationCallOrder[0]!,
  );
});

it('returns home before restoring the saved server connection', async () => {
  render(<DemoBanner />);
  await act(async () => fireEvent.press(screen.getByLabelText('Exit demo')));
  expect(exitDemoMode).toHaveBeenCalledTimes(1);
  expect(jest.mocked(router.replace).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(exitDemoMode).mock.invocationCallOrder[0]!,
  );
});

it('allows retry when exiting cannot persist the mode change', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.mocked(exitDemoMode).mockRejectedValueOnce(new Error('Storage unavailable'));
  try {
    render(<DemoBanner />);
    await act(async () => fireEvent.press(screen.getByLabelText('Exit demo')));
    expect(alert).toHaveBeenCalledWith('Could not exit demo', 'Please try again.');
    expect(screen.getByLabelText('Exit demo')).toBeEnabled();
  } finally {
    alert.mockRestore();
  }
});
